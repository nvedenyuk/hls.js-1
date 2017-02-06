/*
 * Stream Controller
*/

import Demuxer from '../demux/demuxer';
import Event from '../events';
import EventHandler from '../event-handler';
import {logger} from '../utils/logger';
import BinarySearch from '../utils/binary-search';
import BufferHelper from '../helper/buffer-helper';
import LevelHelper from '../helper/level-helper';
import {ErrorTypes, ErrorDetails} from '../errors';

const State = {
  STOPPED : 'STOPPED',
  STARTING : 'STARTING',
  IDLE : 'IDLE',
  PAUSED : 'PAUSED',
  KEY_LOADING : 'KEY_LOADING',
  FRAG_LOADING : 'FRAG_LOADING',
  FRAG_LOADING_WAITING_RETRY : 'FRAG_LOADING_WAITING_RETRY',
  WAITING_LEVEL : 'WAITING_LEVEL',
  PARSING : 'PARSING',
  PARSED : 'PARSED',
  ENDED : 'ENDED',
  ERROR : 'ERROR'
};

class StreamController extends EventHandler {

  constructor(hls) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING,
      Event.MANIFEST_LOADING,
      Event.MANIFEST_PARSED,
      Event.LEVEL_LOADED,
      Event.LEVEL_PTS_UPDATED,
      Event.KEY_LOADED,
      Event.FRAG_CHUNK_LOADED,
      Event.FRAG_LOADED,
      Event.FRAG_LOAD_EMERGENCY_ABORTED,
      Event.FRAG_PARSING_INIT_SEGMENT,
      Event.FRAG_PARSING_DATA,
      Event.FRAG_PARSED,
      Event.FRAG_APPENDED,
      Event.ERROR,
      Event.BUFFER_FLUSHED,
      Event.DEMUXER_QUEUE_EMPTY);

    this.config = hls.config;
    this.audioCodecSwap = false;
    this.ticks = 0;
    this.ontick = this.tick.bind(this);
    this.noMediaCount = 0;
  }

  destroy() {
    this.stopLoad();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    EventHandler.prototype.destroy.call(this);
    this.state = State.STOPPED;
  }

  startLoad(startPosition=0) {
    if (this.levels) {
      var media = this.media, lastCurrentTime = this.lastCurrentTime;
      this.stopLoad();
      if (!this.demuxer) {
        this.demuxer = new Demuxer(this.hls);
        this.fragParsing = null;
      }
      if (!this.timer) {
        this.timer = setInterval(this.ontick, 100);
      }
      this.level = -1;
      this.fragLoadError = 0;
      if (media && lastCurrentTime > 0) {
        logger.log(`configure startPosition @${lastCurrentTime}`);
        if (!this.lastPaused) {
          logger.log('resuming video');
          media.play();
        }
        this.state = State.IDLE;
      } else {
        this.lastCurrentTime = this.startPosition ? this.startPosition : startPosition;
        logger.log(`configure lastCurrentTime @${this.lastCurrentTime} start:${this.startPosition},${startPosition}`);
        this.state = State.STARTING;
      }
      this.nextLoadPosition = this.startPosition = this.lastCurrentTime;
      this.tick();
    } else {
      logger.warn('cannot start loading as manifest not parsed yet');
      this.state = State.STOPPED;
    }
  }

  onDemuxerQueueEmpty() {
    this.fragParsing = null;
  }

  stopLoad() {
    var frag = this.fragCurrent;
    if (frag) {
      if (frag.loader) {
        frag.loader.abort();
      }
      this.fragCurrent = null;
    }
    this.fragPrevious = null;
    if (this.state === State.PARSING && this.demuxer && this.config.enableWorker) {
      this.fragParsing = frag;
      this.demuxer.waitQueue();
    }
    this.state = State.STOPPED;
  }

  tick() {
    this.ticks++;
    if (this.ticks === 1) {
      this.doTick();
      if (this.ticks > 1) {
        setTimeout(this.tick, 1);
      }
      this.ticks = 0;
    }
  }

  doTick() {
    switch(this.state) {
      case State.STARTING:
        var hls = this.hls;
        // determine load level
        let startLevel = hls.startLevel;
        if (startLevel === -1) {
          startLevel = 0;
        }
        // set new level to playlist loader : this will trigger start level load
        // hls.nextLoadLevel remains until it is set to a new value or until a new frag is successfully loaded
        this.level = hls.nextLoadLevel = startLevel;
        this.state = State.WAITING_LEVEL;
        this.loadedmetadata = false;
        break;
      case State.IDLE:
        if (!this.media) {
          if ((this.noMediaCount++%20) === 0) {
             let media = this.hls.bufferController.media||{};
             let ms = this.hls.bufferController.mediaSource||{};
             logger.log(`no media ${media} src=${media.src} ms_state=${ms.readyState}`);
          }
        } else {
          if (this.noMediaCount) {
            logger.log(`media is set to ${this.media.src}`);
          }
          this.noMediaCount = 0;
        }
        // when this returns false there was an error and we shall return immediatly
        // from current tick
        if (!this._doTickIdle()) {
          return;
        }
        break;
      case State.WAITING_LEVEL:
        var level = this.levels[this.level];
        // check if playlist is already loaded
        if (level && level.details) {
          this.state = State.IDLE;
        }
        break;
      case State.FRAG_LOADING:
        try {
          if (this.levels[this.level].details.live && this.fragCurrent.sn<this.levels[this.level].details.startSN) {
            logger.log(`live playlist slided forward loading segments: reload`);
            this.state = State.IDLE;
          }
        } catch(e){}
        break;
      case State.FRAG_LOADING_WAITING_RETRY:
        var now = performance.now();
        var retryDate = this.retryDate;
        // if current time is gt than retryDate, or if media seeking let's switch to IDLE state to retry loading
        if(!retryDate || (now >= retryDate) || (this.media && this.media.seeking)) {
          logger.log(`mediaController: retryDate reached, switch back to IDLE state`);
          this.state = State.IDLE;
        }
        break;
      case State.ERROR:
      case State.PAUSED:
      case State.STOPPED:
      case State.PARSING:
      case State.PARSED:
      case State.ENDED:
        break;
      default:
        break;
    }
    // check buffer
    this._checkBuffer();
    // check/update current fragment
    this._checkFragmentChanged();
  }

  // Ironically the "idle" state is the on we do the most logic in it seems ....
  // NOTE: Maybe we could rather schedule a check for buffer length after half of the currently
  //       played segment, or on pause/play/seek instead of naively checking every 100ms?
  _doTickIdle() {
    const hls = this.hls,
          config = hls.config;

    // if video not attached AND
    // start fragment already requested OR start frag prefetch disable
    // exit loop
    // => if media not attached but start frag prefetch is enabled and start frag not requested yet, we will not exit loop
    if (this.levelLastLoaded !== undefined && !this.media &&
      (this.startFragRequested || !config.startFragPrefetch)) {
      return true;
    }

    // if we have not yet loaded any fragment, start loading from start position
    let pos;
    if (this.loadedmetadata) {
      pos = this.media.currentTime;
    } else {
      pos = this.nextLoadPosition;
    }
    // determine next load level
    let level = hls.nextLoadLevel;

    // compute max Buffer Length that we could get from this load level, based on level bitrate. don't buffer more than 60 MB and more than 30s
    let maxBufLen;
    if ((this.levels[level]).hasOwnProperty('bitrate')) {
      maxBufLen = Math.max(8 * config.maxBufferSize / this.levels[level].bitrate, config.maxBufferLength);
      maxBufLen = Math.min(maxBufLen, config.maxMaxBufferLength);
    } else {
      maxBufLen = config.maxBufferLength;
    }

    // determine next candidate fragment to be loaded, based on current position and end of buffer position
    // ensure up to `config.maxMaxBufferLength` of buffer upfront

    const bufferInfo = BufferHelper.bufferInfo(this.media, pos, config.maxBufferHole),
          bufferLen = bufferInfo.len;
    // Stay idle if we are still with buffer margins
    if (bufferLen >= maxBufLen) {
      return true;
    }

    // if buffer length is less than maxBufLen try to load a new fragment ...
    logger.trace(`buffer length of ${bufferLen.toFixed(3)} is below max of ${maxBufLen.toFixed(3)}. checking for more payload ...`);

    // set next load level : this will trigger a playlist load if needed
    this.level = hls.nextLoadLevel = level;

    const levelDetails = this.levels[level].details;
    // if level info not retrieved yet, switch state and wait for level retrieval
    // if live playlist, ensure that new playlist has been refreshed to avoid loading/try to load
    // a useless and outdated fragment (that might even introduce load error if it is already out of the live playlist)
    if (typeof levelDetails === 'undefined' || levelDetails.live && this.levelLastLoaded !== level) {
      this.state = State.WAITING_LEVEL;
      return true;
    }

    // if we have the levelDetails for the selected variant, lets continue enrichen our stream (load keys/fragments or trigger EOS, etc..)
    return this._fetchPayloadOrEos({pos, bufferInfo, levelDetails});
  }

  _fetchPayloadOrEos({pos, bufferInfo, levelDetails}) {
    const fragPrevious = this.fragPrevious,
          level = this.level,
          fragments = levelDetails.fragments,
          fragLen = fragments.length;

    // empty playlist
    if (fragLen === 0) {
      return false;
    }

    // find fragment index, contiguous with end of buffer position
    let start = fragments[0].start,
        end = fragments[fragLen-1].start + fragments[fragLen-1].duration,
        bufferEnd = bufferInfo.end,
        frag;

    // in case of live playlist we need to ensure that requested position is not located before playlist start
    if (levelDetails.live) {
      frag = this._ensureFragmentAtLivePoint({levelDetails, bufferEnd, start, end, fragPrevious, fragments, fragLen});
      // if it explicitely returns null don't load any fragment and exit function now
      if (frag === null) {
        return false;
      }

    } else {
      // VoD playlist: if bufferEnd before start of playlist, load first fragment
      if (bufferEnd < start) {
        frag = fragments[0];
      }
    }
    if (!frag) {
      frag = this._findFragment({start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails});
    }
    if(frag) {
      return this._loadFragmentOrKey({frag, level, levelDetails, pos, bufferEnd});
    }
    return true;
  }

  _ensureFragmentAtLivePoint({levelDetails, bufferEnd, start, end, fragPrevious, fragments, fragLen}) {
    const config = this.hls.config, media = this.media;

    let frag;

    // check if requested position is within seekable boundaries :
    //logger.log(`start/pos/bufEnd/seeking:${start.toFixed(3)}/${pos.toFixed(3)}/${bufferEnd.toFixed(3)}/${this.media.seeking}`);
    let maxLatency = config.liveMaxLatencyDuration !== undefined ? config.liveMaxLatencyDuration : config.liveMaxLatencyDurationCount*levelDetails.targetduration;

    if (bufferEnd < Math.max(start-config.maxFragLookUpTolerance, end - maxLatency)) {
        let liveSyncPosition = this.computeLivePosition(start, levelDetails);
        logger.log(`buffer end: ${bufferEnd.toFixed(3)} is located too far from the end of live sliding playlist, reset currentTime to : ${liveSyncPosition.toFixed(3)}`);
        bufferEnd = liveSyncPosition;
        if (media && media.readyState && media.duration > liveSyncPosition) {
          media.currentTime = liveSyncPosition;
        }
    }

    // if end of buffer greater than live edge, don't load any fragment
    // this could happen if live playlist intermittently slides in the past.
    // level 1 loaded [182580161,182580167]
    // level 1 loaded [182580162,182580169]
    // Loading 182580168 of [182580162 ,182580169],level 1 ..
    // Loading 182580169 of [182580162 ,182580169],level 1 ..
    // level 1 loaded [182580162,182580168] <============= here we should have bufferEnd > end. in that case break to avoid reloading 182580168
    // level 1 loaded [182580164,182580171]
    //
    if (levelDetails.PTSKnown && bufferEnd > end && media && media.readyState) {
      return null;
    }

    if (this.startFragRequested && !levelDetails.PTSKnown) {
      /* we are switching level on live playlist, but we don't have any PTS info for that quality level ...
         try to load frag matching with next SN.
         even if SN are not synchronized between playlists, loading this frag will help us
         compute playlist sliding and find the right one after in case it was not the right consecutive one */
      if (fragPrevious) {
        var targetSN = fragPrevious.sn + 1;
        if (targetSN >= levelDetails.startSN && targetSN <= levelDetails.endSN) {
          frag = fragments[targetSN - levelDetails.startSN];
          logger.log(`live playlist, switching playlist, load frag with next SN: ${frag.sn}`);
        }
      }
      if (!frag) {
        /* we have no idea about which fragment should be loaded.
           so let's load mid fragment. it will help computing playlist sliding and find the right one
        */
        frag = fragments[Math.min(fragLen - 1, Math.round(fragLen / 2))];
        logger.log(`live playlist, switching playlist, unknown, load middle frag : ${frag.sn}`);
      }
    }
    return frag;
  }

  _findFragment({start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails, holaSeek}) {
    const config = this.hls.config;
    let frag,
        foundFrag,
        maxFragLookUpTolerance = config.maxFragLookUpTolerance,
        media = this.media,
        seekFlag = media && media.seeking || holaSeek;

    if (bufferEnd < end-(fragments[fragLen-1].PTSDTSshift||0)-0.05) {
      if (bufferEnd > end - maxFragLookUpTolerance || seekFlag) {
        maxFragLookUpTolerance = 0;
      }
      foundFrag = BinarySearch.search(fragments, (candidate) => {
        // offset should be within fragment boundary - config.maxFragLookUpTolerance
        // this is to cope with situations like
        // bufferEnd = 9.991
        // frag[Ø] : [0,10]
        // frag[1] : [10,20]
        // bufferEnd is within frag[0] range ... although what we are expecting is to return frag[1] here
            //              frag start               frag start+duration
            //                  |-----------------------------|
            //              <--->                         <--->
            //  ...--------><-----------------------------><---------....
            // previous frag         matching fragment         next frag
            //  return -1             return 0                 return 1
        //logger.log(`level/sn/start/end/bufEnd:${level}/${candidate.sn}/${candidate.start}/${(candidate.start+candidate.duration)}/${bufferEnd}`);
        // if we are in seek, the condition will always be false
        if (candidate.lastGop - maxFragLookUpTolerance < bufferEnd && candidate.lastGop + maxFragLookUpTolerance > bufferEnd) {
          return 1;
        }
        // if we are in seek, the condition will always be false
        if (candidate.firstGop - maxFragLookUpTolerance < bufferEnd && candidate.firstGop + maxFragLookUpTolerance > bufferEnd) {
          return 0;
        }
        if (candidate.start + candidate.duration - candidate.PTSDTSshift - maxFragLookUpTolerance <= bufferEnd) {
          return 1;
        }
        // if maxFragLookUpTolerance will have negative value then don't return -1 for first element
        if (candidate.start - candidate.PTSDTSshift - maxFragLookUpTolerance > bufferEnd && candidate.start) {
          return candidate.sn>levelDetails.startSN ? -1 : 0;
        }
        return 0;
      });
    } else {
      // reach end of playlist
      foundFrag = fragments[fragLen-1];
    }
    if (foundFrag) {
      frag = foundFrag;
      start = foundFrag.start;
      logger.log('find SN matching with pos:' +  bufferEnd + ':' + frag.sn);
      if (fragPrevious && frag.sn === fragPrevious.sn) {
        if (frag.sn < levelDetails.endSN) {
          let deltaPTS = fragPrevious.deltaPTS,
          curSNIdx = frag.sn - levelDetails.startSN;
          // if there is a significant delta between audio and video, larger than max allowed hole,
          // and if previous remuxed fragment did not start with a keyframe. (fragPrevious.dropped)
          // let's try to load previous fragment again to get last keyframe
          // then we will reload again current fragment (that way we should be able to fill the buffer hole ...)
          if (this.loadedmetadata && deltaPTS && deltaPTS > config.maxSeekHole && fragPrevious.dropped && (!media || !BufferHelper.isBuffered(media, bufferEnd))) {
            frag = fragments[curSNIdx-1];
            logger.warn(`SN just loaded, with large PTS gap between audio and video, maybe frag is not starting with a keyframe ? load previous one to try to overcome this`);
            // decrement previous frag load counter to avoid frag loop loading error when next fragment will get reloaded
            fragPrevious.loadCounter--;
          } else {
            frag = fragments[curSNIdx+1];
            logger.log(`SN just loaded, load next one: ${frag.sn}`);
          }
        } else {
          // have we reached end of VOD playlist ?
          if (!levelDetails.live) {
            // Finalize the media stream
            this.hls.trigger(Event.BUFFER_EOS);
            // We might be loading the last fragment but actually the media
            // is currently processing a seek command and waiting for new data to resume at another point.
            // Going to ended state while media is seeking can spawn an infinite buffering broken state.
            if (!this.media.seeking) {
              this.state = State.ENDED;
            }
          }
          frag = null;
        }
      }
    }
    return frag;
  }

  _loadFragmentOrKey({frag, level, levelDetails, pos, bufferEnd}) {
    const hls = this.hls,
          config = hls.config;

    //logger.log('loading frag ' + i +',pos/bufEnd:' + pos.toFixed(3) + '/' + bufferEnd.toFixed(3));
    if ((frag.decryptdata.uri != null) && (frag.decryptdata.key == null)) {
      logger.log(`Loading key for ${frag.sn} of [${levelDetails.startSN} ,${levelDetails.endSN}],level ${level}`);
      this.state = State.KEY_LOADING;
      hls.trigger(Event.KEY_LOADING, {frag: frag});
    } else {
      logger.log(`Loading ${frag.sn} of [${levelDetails.startSN} ,${levelDetails.endSN}],level ${level}, currentTime:${pos},bufferEnd:${bufferEnd.toFixed(3)}`);
      frag.autoLevel = hls.autoLevelEnabled;
      if (this.levels.length > 1) {
        frag.expectedLen = Math.round(frag.duration * this.levels[level].bitrate / 8);
        frag.trequest = performance.now();
      }
      // ensure that we are not reloading the same fragments in loop ...
      if (this.fragLoadIdx !== undefined) {
        this.fragLoadIdx++;
      } else {
        this.fragLoadIdx = 0;
      }
      if (frag.loadCounter) {
        frag.loadCounter++;
        let maxThreshold = config.fragLoadingLoopThreshold;
        // if this frag has already been loaded 3 times, and if it has been reloaded recently
        if (frag.loadCounter > maxThreshold && (Math.abs(this.fragLoadIdx - frag.loadIdx) < maxThreshold)) {
          hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_LOOP_LOADING_ERROR, fatal: false, frag: frag});
          return false;
        }
      } else {
        frag.loadCounter = 1;
      }
      frag.loadIdx = this.fragLoadIdx;
      this.fragCurrent = frag;
      this.fragCurrent.loaded = false;
      this.startFragRequested = true;
      this.nextLoadPosition = frag.start + frag.duration;
      this.fragTimeOffset = frag.start;
      // lazy demuxer init, as this could take some time ... do it during frag loading
      if (!this.demuxer) {
        this.demuxer = new Demuxer(hls,'main');
      }
      this.state = State.FRAG_LOADING;
      hls.trigger(Event.FRAG_LOADING, {frag: frag});
      return true;
    }
  }

  set state(nextState) {
    if (this.state !== nextState) {
      const previousState = this.state;
      this._state = nextState;
      logger.log(`engine state transition from ${previousState} to ${nextState}`);
      if (nextState === 'IDLE') {
        let media = this.media||{};
        logger.log(`media ${media} ct=${media.currentTime} dur=${media.duration} buf=${this.timeRangesToString(media.buffered)} err=${media.error}`);
      }
      this.hls.trigger(Event.STREAM_STATE_TRANSITION, {previousState, nextState});
    }
  }

  get state() {
    return this._state;
  }

  getBufferRange(position) {
    var i, range,
        bufferRange = this.bufferRange;
    if (bufferRange) {
      for (i = bufferRange.length - 1; i >=0; i--) {
        range = bufferRange[i];
        if (position >= range.start && position <= range.end) {
          return range;
        }
      }
    }
    return null;
  }

  get currentLevel() {
    if (this.media) {
      var range = this.getBufferRange(this.media.currentTime);
      if (range) {
        return range.frag.level;
      }
    }
    return -1;
  }

  get nextBufferRange() {
    if (this.media) {
      // first get end range of current fragment
      return this.followingBufferRange(this.getBufferRange(this.media.currentTime));
    } else {
      return null;
    }
  }

  followingBufferRange(range) {
    if (range) {
      // try to get range of next fragment (500ms after this range)
      return this.getBufferRange(range.end + 0.5);
    }
    return null;
  }

  get nextLevel() {
    var range = this.nextBufferRange;
    if (range) {
      return range.frag.level;
    } else {
      return -1;
    }
  }

  isBuffered(position) {
    let media = this.media;
    if (media) {
      let buffered = media.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (position >= buffered.start(i) && position <= buffered.end(i)) {
          return true;
        }
      }
    }
    return false;
  }

  _checkFragmentChanged() {
    var currentTime, video = this.media;
    if (video && video.seeking === false) {
      currentTime = video.currentTime;
      /* if video element is in seeked state, currentTime can only increase.
        (assuming that playback rate is positive ...)
        As sometimes currentTime jumps back to zero after a
        media decode error, check this, to avoid seeking back to
        wrong position after a media decode error
      */
      if(currentTime > video.playbackRate*this.lastCurrentTime) {
        this.lastCurrentTime = currentTime;
      }
    }
  }

  /*
    on immediate level switch :
     - pause playback if playing
     - cancel any pending load request
     - and trigger a buffer flush
  */
  immediateLevelSwitch() {
    logger.log('immediateLevelSwitch');
    if (!this.immediateSwitch) {
      this.immediateSwitch = true;
      this.previouslyPaused = this.media.paused;
      this.media.pause();
    }
    var fragCurrent = this.fragCurrent;
    if (fragCurrent && fragCurrent.loader) {
      fragCurrent.loader.abort();
    }
    this.fragCurrent = null;
    // increase fragment load Index to avoid frag loop loading error after buffer flush
    this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
    this.state = State.PAUSED;
    // flush everything
    this.hls.trigger(Event.BUFFER_FLUSHING, {startOffset: 0, endOffset: Number.POSITIVE_INFINITY});
  }

  /*
     on immediate level switch end, after new fragment has been buffered :
      - nudge video decoder by slightly adjusting video currentTime
      - resume the playback if needed
  */
  immediateLevelSwitchEnd() {
    let media = this.media;
    if (media && media.buffered.length) {
      this.immediateSwitch = false;
      if(BufferHelper.isBuffered(media,media.currentTime)) {
        // only nudge if currentTime is buffered
        media.currentTime -= 0.0001;
      }
      if (!this.previouslyPaused) {
        media.play();
      }
    }
  }

  nextLevelSwitch() {
    /* try to switch ASAP without breaking video playback :
       in order to ensure smooth but quick level switching,
      we need to find the next flushable buffer range
      we should take into account new segment fetch time
    */
    let media = this.media;
    // ensure that media is defined and that metadata are available (to retrieve currentTime)
    if (media && media.readyState) {
      let fetchdelay, currentRange, nextRange;
      // increase fragment load Index to avoid frag loop loading error after buffer flush
      this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
      currentRange = this.getBufferRange(media.currentTime);
      if (currentRange && currentRange.start > 1) {
      // flush buffer preceding current fragment (flush until current fragment start offset)
      // minus 1s to avoid video freezing, that could happen if we flush keyframe of current video ...
        this.state = State.PAUSED;
        this.hls.trigger(Event.BUFFER_FLUSHING, {startOffset: 0, endOffset: currentRange.start - 1});
      }
      if (!media.paused) {
        // add a safety delay of 1s
        var nextLevelId = this.hls.nextLoadLevel,nextLevel = this.levels[nextLevelId], fragLastKbps = this.fragLastKbps;
        if (fragLastKbps && this.fragCurrent) {
          fetchdelay = this.fragCurrent.duration * nextLevel.bitrate / (1000 * fragLastKbps) + 1;
        } else {
          fetchdelay = 0;
        }
      } else {
        fetchdelay = 0;
      }
      //logger.log('fetchdelay:'+fetchdelay);
      // find buffer range that will be reached once new fragment will be fetched
      nextRange = this.getBufferRange(media.currentTime + fetchdelay);
      if (nextRange) {
        // we can flush buffer range following this one without stalling playback
        nextRange = this.followingBufferRange(nextRange);
        if (nextRange) {
          // if we are here, we can also cancel any loading/demuxing in progress, as they are useless
          var fragCurrent = this.fragCurrent;
          if (fragCurrent && fragCurrent.loader) {
            fragCurrent.loader.abort();
          }
          this.fragCurrent = null;
          // flush position is the start position of this new buffer
          this.state = State.PAUSED;
          this.hls.trigger(Event.BUFFER_FLUSHING, {startOffset: nextRange.start, endOffset: Number.POSITIVE_INFINITY});
        }
      }
    }
  }

  onMediaAttached(data) {
    var media = this.media = data.media;
    this.onvseeking = this.onMediaSeeking.bind(this);
    this.onvseeked = this.onMediaSeeked.bind(this);
    this.onvended = this.onMediaEnded.bind(this);
    media.addEventListener('seeking', this.onvseeking);
    media.addEventListener('seeked', this.onvseeked);
    media.addEventListener('ended', this.onvended);
    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = new Demuxer(this.hls);
      this.fragParsing = null;
    }
    if(this.levels && this.config.autoStartLoad) {
      this.hls.startLoad();
    }
  }

  onMediaDetaching() {
    var media = this.media;
    if (media && media.ended || this.state === State.ENDED) {
      logger.log('MSE detaching and video ended, reset startPosition');
      this.startPosition = this.lastCurrentTime = 0;
    }

    // reset fragment loading counter on MSE detaching to avoid reporting FRAG_LOOP_LOADING_ERROR after error recovery
    var levels = this.levels;
    if (levels) {
      // reset fragment load counter
        levels.forEach(level => {
          if(level.details) {
            level.details.fragments.forEach(fragment => {
              fragment.loadCounter = undefined;
            });
          }
      });
    }
    // remove video listeners
    if (media) {
      media.removeEventListener('seeking', this.onvseeking);
      media.removeEventListener('seeked', this.onvseeked);
      media.removeEventListener('ended', this.onvended);
      this.onvseeking = this.onvseeked  = this.onvended = null;
    }
    this.media = null;
    this.loadedmetadata = false;
    this.stopLoad();
    this.fragParsing = null;
  }

  onMediaSeeking() {
    let currentTime = this.media.currentTime;
    logger.log('media seeking to ' + currentTime);
    var fragCurrent = this.fragCurrent;
    if (this.state === State.FRAG_LOADING) {
      // check if currently loaded fragment is inside buffer.
      //if outside, cancel fragment loading, otherwise do nothing
      if (BufferHelper.bufferInfo(this.media,currentTime,0).len === 0) {
        logger.log('seeking outside of buffer while fragment load in progress, cancel fragment load');
        if (fragCurrent) {
          if (fragCurrent.loader) {
            fragCurrent.loader.abort();
          }
          this.fragCurrent = null;
        }
        this.fragPrevious = null;
        // switch to IDLE state to load new fragment
        this.state = State.IDLE;
      }
    } else if (this.state === State.ENDED) {
      // switch to IDLE state to check for potential new fragment
      this.state = State.IDLE;
    } else if (this.state === State.PARSING && fragCurrent && !fragCurrent.loaded) {
      logger.log(`mediaController: no final chunk, switch back to IDLE state`);
      this.state = State.IDLE;
    }
    if (this.media) {
      this.lastCurrentTime = currentTime;
    }
    // avoid reporting fragment loop loading error in case user is seeking several times on same position
    if (this.fragLoadIdx !== undefined) {
      this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
    }
    // in case seeking occurs although no media buffered, adjust startPosition and nextLoadPosition to seek target
    if (!this.loadedmetadata) {
      this.nextLoadPosition = this.startPosition = currentTime;
    }
    // tick to speed up processing
    this.tick();
  }

  onMediaSeeked() {
    logger.log('media seeked to ' + this.media.currentTime);
    // tick to speed up FRAGMENT_PLAYING triggering
    this.tick();
  }

  onMediaEnded() {
    logger.log('media ended');
    // reset startPosition and lastCurrentTime to restart playback @ stream beginning
    this.startPosition = this.lastCurrentTime = 0;
  }


  onManifestLoading() {
    // reset buffer on manifest loading
    logger.log('trigger BUFFER_RESET');
    this.hls.trigger(Event.BUFFER_RESET);
    this.bufferRange = [];
    this.stalled = false;
    this.startPosition = this.lastCurrentTime = 0;
    this.fragParsing = null;
  }

  onManifestParsed(data) {
    var aac = false, heaac = false, codec;
    data.levels.forEach(level => {
      // detect if we have different kind of audio codecs used amongst playlists
      codec = level.audioCodec;
      if (codec) {
        if (codec.indexOf('mp4a.40.2') !== -1) {
          aac = true;
        }
        if (codec.indexOf('mp4a.40.5') !== -1) {
          heaac = true;
        }
      }
    });
    this.audioCodecSwitch = (aac && heaac);
    if (this.audioCodecSwitch) {
      logger.log('both AAC/HE-AAC audio found in levels; declaring level codec as HE-AAC');
    }
    this.levels = data.levels;
    this.startLevelLoaded = false;
    this.startFragRequested = false;
    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = new Demuxer(this.hls);
      this.fragParsing = null;
    }
    if (this.config.autoStartLoad) {
      this.hls.startLoad();
    }
  }

  onLevelLoaded(data) {
    var newDetails = data.details,
        newLevelId = data.level,
        curLevel = this.levels[newLevelId],
        duration = newDetails.totalduration,
        sliding = 0,
        lastDetails = this.levelLastLoaded !== undefined && this.levels[this.levelLastLoaded] && this.levels[this.levelLastLoaded].details;

    logger.log(`level ${newLevelId} loaded [${newDetails.startSN},${newDetails.endSN}],duration:${duration}`);

    if (newDetails.live) {
      var curDetails = curLevel.details;

      if (lastDetails) {
        let {start, end} = LevelHelper.probeDetails(lastDetails, newDetails);
        if (end >= start) {
          curDetails = lastDetails;
        }
      }

      if (curDetails) {
        // we already have details for that level, merge them
        LevelHelper.mergeDetails(curDetails, newDetails);
        sliding = newDetails.fragments[0].start;
        if (newDetails.PTSKnown) {
          logger.log(`live playlist sliding:${sliding.toFixed(3)}`);
        } else {
          logger.log('live playlist - outdated PTS, unknown sliding');
        }
      } else {
        newDetails.PTSKnown = false;
        logger.log('live playlist - first load, unknown sliding');
      }
    } else {
      newDetails.PTSKnown = false;
      if (lastDetails) {
        LevelHelper.mergeDetails(lastDetails, newDetails);
      }
    }
    // override level info
    this.levelLastLoaded = newLevelId;
    curLevel.details = newDetails;
    this.hls.trigger(Event.LEVEL_UPDATED, { details: newDetails, level: newLevelId });

    // compute start position
    if (this.startFragRequested === false) {
      // if live playlist, set start position to be fragment N-this.config.liveSyncDurationCount (usually 3)
      if (newDetails.live) {
        this.startPosition = this.computeLivePosition(sliding, newDetails);
        logger.log(`configure startPosition to ${this.startPosition}`);
      }
      this.nextLoadPosition = this.startPosition;
    }
    // only switch batck to IDLE state if we were waiting for level to start downloading a new fragment
    if (this.state === State.WAITING_LEVEL) {
      this.state = State.IDLE;
    }
    //trigger handler right now
    this.tick();
  }

  onKeyLoaded() {
    if (this.state === State.KEY_LOADING) {
      this.state = State.IDLE;
      this.tick();
    }
  }

  onFragChunkLoaded(data) {
    var fragCurrent = this.fragCurrent;
    if ((this.state === State.FRAG_LOADING || this.state === State.PARSING) &&
        fragCurrent && data.frag.level === fragCurrent.level &&
        data.frag.sn === fragCurrent.sn) {
      logger.log(`Loaded chunk ${data.payload.byteLength} of frag ${fragCurrent.sn} of level ${fragCurrent.level}`);
      this.state = State.PARSING;
      // transmux the MPEG-TS data to ISO-BMFF segments
      this.stats = data.stats;
      var level = fragCurrent.level,
          fragLevel = this.levels[level],
          details = fragLevel.details,
          duration = details.totalduration,
          start = this.fragTimeOffset,
          sn = fragCurrent.sn,
          audioCodec = this.config.defaultAudioCodec || fragLevel.audioCodec;
      if(this.audioCodecSwap) {
        logger.log('swapping playlist audio codec');
        if(audioCodec === undefined) {
          audioCodec = this.lastAudioCodec;
        }
        if(audioCodec) {
          if(audioCodec.indexOf('mp4a.40.5') !==-1) {
            audioCodec = 'mp4a.40.2';
          } else {
            audioCodec = 'mp4a.40.5';
          }
        }
      }
      logger.log(`Demuxing ${sn} of [${details.startSN} ,${details.endSN}],level ${level}, cc ${fragCurrent.cc}`);
      let demuxer = this.demuxer;
      if (demuxer) {
        demuxer.push(data.payload, audioCodec, fragLevel.videoCodec, start, fragCurrent.cc, level, sn, duration, fragCurrent.decryptdata, details.PTSKnown || !details.live, details.endSN);
      }
      if (data.payload.final) {
        fragCurrent.loaded = true;
      }
    }
  }

  onFragLoaded() {
    logger.log(`Loaded ${this.fragCurrent.sn} of level ${this.fragCurrent.level}`);
    this.fragLoadError = 0;
  }

  onFragParsingInitSegment(data) {
    if (this.state === State.PARSING) {
      var tracks = data.tracks, trackName, track;

      // include levelCodec in audio and video tracks
      track = tracks.audio;
      if (track) {
        var audioCodec = this.levels[this.level].audioCodec,
            ua = navigator.userAgent.toLowerCase();
        if(audioCodec && this.audioCodecSwap) {
          logger.log('swapping playlist audio codec');
          if(audioCodec.indexOf('mp4a.40.5') !==-1) {
            audioCodec = 'mp4a.40.2';
          } else {
            audioCodec = 'mp4a.40.5';
          }
        }
        // in case AAC and HE-AAC audio codecs are signalled in manifest
        // force HE-AAC , as it seems that most browsers prefers that way,
        // except for mono streams OR on FF
        // these conditions might need to be reviewed ...
        if (this.audioCodecSwitch) {
            // don't force HE-AAC if mono stream
           if(track.metadata.channelCount !== 1 &&
            // don't force HE-AAC if firefox
            ua.indexOf('firefox') === -1) {
              audioCodec = 'mp4a.40.5';
          }
        }
        // HE-AAC is broken on Android, always signal audio codec as AAC even if variant manifest states otherwise
        if(ua.indexOf('android') !== -1 && track.container !== 'audio/mpeg') {
          audioCodec = 'mp4a.40.2';
          logger.log(`Android: force audio codec to ${audioCodec}`);
        }
        track.levelCodec = audioCodec;
      }
      track = tracks.video;
      if(track) {
        track.levelCodec = this.levels[this.level].videoCodec;
      }

      // if remuxer specify that a unique track needs to generated,
      // let's merge all tracks together
      if (data.unique) {
        var mergedTrack = {
            codec : '',
            levelCodec : ''
          };
        for (trackName in data.tracks) {
          track = tracks[trackName];
          mergedTrack.container = track.container;
          if (mergedTrack.codec) {
            mergedTrack.codec +=  ',';
            mergedTrack.levelCodec +=  ',';
          }
          if(track.codec) {
            mergedTrack.codec +=  track.codec;
          }
          if (track.levelCodec) {
            mergedTrack.levelCodec +=  track.levelCodec;
          }
        }
        tracks = { audiovideo : mergedTrack };
      }
      this.hls.trigger(Event.BUFFER_CODECS,tracks);
      // loop through tracks that are going to be provided to bufferController
      for (trackName in tracks) {
        track = tracks[trackName];
        var initSegment = track.initSegment;
        logger.log(`track:${trackName},container:${track.container},codecs[level/parsed]=[${track.levelCodec}/${track.codec}]${initSegment ? ',init:'+initSegment.length : ''}`);
        if (initSegment) {
          this.hls.trigger(Event.BUFFER_APPENDING, {type: trackName, data: initSegment});
        }
      }
      //trigger handler right now
      this.tick();
    }
  }

  onFragParsingData(data) {
    if (this.state === State.PARSING || this.fragParsing) {
      this.tparse2 = Date.now();
      var frag = this.fragCurrent||this.fragParsing;
      logger.log(`parsed ${data.type},PTS:[${data.startPTS.toFixed(3)},${data.endPTS.toFixed(3)}],DTS:[${data.startDTS.toFixed(3)}/${data.endDTS.toFixed(3)}],nb:${data.nb},dropped:${data.dropped || 0},deltaPTS:${data.deltaPTS || 0}`);
      var hls = this.hls;

      // has remuxer dropped video frames located before first keyframe ?
      if(data.type === 'video') {
        frag.dropped = data.dropped;
        if (data.deltaPTS) {
          if (isNaN(frag.deltaPTS)) {
            frag.deltaPTS = data.deltaPTS;
          } else {
            frag.deltaPTS = Math.max(data.deltaPTS, frag.deltaPTS);
          }
        }
      }

      [data.data1, data.data2].forEach(buffer => {
        if (buffer) {
          hls.trigger(Event.BUFFER_APPENDING, {type: data.type, data: buffer});
        }
      });

      this.bufferRange.push({type: data.type, start: data.startPTS, end: data.endPTS, frag: frag});

      //trigger handler right now
      this.tick();
    } else {
      logger.warn(`not in PARSING state but ${this.state}, ignoring FRAG_PARSING_DATA event`);
    }
  }

  onFragParsed(data) {
    if (this.state === State.PARSING) {
      var frag = this.fragCurrent, level = this.levels[frag.level];
      this.stats.tparsed = performance.now();
      this.state = State.PARSED;
      logger.log(`parsed frag sn:${frag.sn},PTS:[${data.startPTS ? data.startPTS.toFixed(3) : 'none'},${data.endPTS ? data.endPTS.toFixed(3) : 'none'}],PTSDTSshift:${data.PTSDTSshift ? data.PTSDTSshift.toFixed(3) : 'none'},lastGopPTS:${data.lastGopPTS ? data.lastGopPTS.toFixed(3) : 'none'}`);
      if (data.startPTS !== undefined && data.endPTS !== undefined) {
        var drift = LevelHelper.updateFragPTS(level.details, frag.sn, data.startPTS, data.endPTS, data.PTSDTSshift, data.lastGopPTS);
        this.hls.trigger(Event.LEVEL_PTS_UPDATED, {details: level.details, level: frag.level, drift: drift});
      } else {
        // forse reload of prev fragment if video samples not found
        frag.dropped = 1;
        frag.deltaPTS = this.config.maxSeekHole+1;
      }
      this.hls.trigger(Event.FRAG_APPENDING);
    }
  }

  onFragAppended() {
    //trigger handler right now
    if (this.state === State.PARSED)  {
      var frag = this.fragCurrent, stats = this.stats;
      if (frag) {
        this.fragPrevious = frag;
        stats.tbuffered = performance.now();
        this.fragLastKbps = Math.round(8 * stats.length / (stats.tbuffered - stats.tfirst));
        this.hls.trigger(Event.FRAG_BUFFERED, {stats: stats, frag: frag});
        logger.log(`media buffered : ${this.timeRangesToString(this.media.buffered)}`);
        this.state = State.IDLE;
      }
      this.tick();
    } else {
      logger.warn(`not in PARSED state but ${this.state}`);
    }
  }

  onError(data) {
    switch(data.details) {
      case ErrorDetails.FRAG_LOAD_ERROR:
      case ErrorDetails.FRAG_LOAD_TIMEOUT:
        if(!data.fatal) {
          let loadError = (this.fragLoadError||0)+1;
          if (loadError <= this.config.fragLoadingMaxRetry) {
            this.fragLoadError = loadError;
            // reset load counter to avoid frag loop loading error
            data.frag.loadCounter = 0;
            // exponential backoff capped to 64s
            var delay = Math.min(Math.pow(2,loadError-1)*this.config.fragLoadingRetryDelay,64000);
            logger.warn(`mediaController: frag loading failed, retry in ${delay} ms`);
            this.retryDate = performance.now() + delay;
            // retry loading state
            this.state = State.FRAG_LOADING_WAITING_RETRY;
          } else {
            logger.error(`mediaController: ${data.details} reaches max retry, redispatch as fatal ...`);
            // redispatch same error but with fatal set to true
            data.fatal = true;
            this.hls.trigger(Event.ERROR, data);
            this.state = State.ERROR;
          }
        }
        break;
      case ErrorDetails.FRAG_LOOP_LOADING_ERROR:
      case ErrorDetails.LEVEL_LOAD_ERROR:
      case ErrorDetails.LEVEL_LOAD_TIMEOUT:
      case ErrorDetails.KEY_LOAD_ERROR:
      case ErrorDetails.KEY_LOAD_TIMEOUT:
        //  when in ERROR state, don't switch back to IDLE state in case a non-fatal error is received
        if(this.state !== State.ERROR) {
            // if fatal error, stop processing, otherwise move to IDLE to retry loading
            this.state = data.fatal ? State.ERROR : State.IDLE;
            logger.warn(`mediaController: ${data.details} while loading frag,switch to ${this.state} state ...`);
        }
        break;
      case ErrorDetails.BUFFER_FULL_ERROR:
        // trigger a smooth level switch to empty buffers
        // also reduce max buffer length as it might be too high. we do this to avoid loop flushing ...
        this.config.maxMaxBufferLength/=2;
        logger.warn(`reduce max buffer length to ${this.config.maxMaxBufferLength}s and trigger a nextLevelSwitch to flush old buffer and fix QuotaExceededError`);
        this.nextLevelSwitch();
        break;
      default:
        break;
    }
  }

  _checkBuffer() {
    var media = this.media;
    if(media && media.readyState) {
      var currentTime;
      currentTime = media.currentTime;
      var loadedmetadata = this.loadedmetadata;

      // adjust currentTime to start position on loaded metadata
      if(!loadedmetadata && media.buffered.length && !media.seeking) {
        this.loadedmetadata = true;
        // only adjust currentTime if different from startPosition or if startPosition not buffered
        // at that stage, there should be only one buffered range, as we reach that code after first fragment has been buffered
        let startPosition = this.startPosition,
            startPositionBuffered = BufferHelper.isBuffered(media, startPosition);
        if (currentTime !== this.startPosition || !startPositionBuffered) {
          logger.log(`target start position:${startPosition}`);
          // if startPosition not buffered, let's seek to buffered.start(0)
          if(!startPositionBuffered) {
            startPosition = media.buffered.start(0);
            logger.log(`target start position not buffered, seek to buffered.start(0) ${startPosition}`);
          }
          logger.log(`adjust currentTime from ${currentTime} to ${startPosition}`);
          media.currentTime = startPosition;
        }
      } else {
        const hls = this.hls;
        let bufferInfo = BufferHelper.bufferInfo(media,currentTime,0),
            expectedPlaying = !(media.paused || // not playing when media is paused
                                media.ended  || // not playing when media is ended
                                media.buffered.length === 0), // not playing if nothing buffered
            jumpThreshold = 0.5, // tolerance needed as some browsers stalls playback before reaching buffered range end
            playheadMoving = currentTime > media.playbackRate*this.lastCurrentTime,
            config = this.config;

        if (playheadMoving) {
          // played moving, but was previously stalled => now not stuck anymore
          if (this.stallReported) {
            logger.warn(`playback not stuck anymore @${currentTime}, after ${Math.round(performance.now()-this.stalled)}ms`);
            this.stallReported = false;
            hls.trigger(Event.BUF_STATISTICS, {bufNotStalled: 1});
          }
          this.stalled = undefined;
          this.nudgeRetry = 0;
        } else {
          // playhead not moving
          if(expectedPlaying) {
            // playhead not moving BUT media expected to play
            const tnow = performance.now();
            if(!this.stalled) {
              // stall just detected, store current time
              this.stalled = tnow;
              this.stallReported = false;
            } else {
              // playback already stalled, check stalling duration
              // if stalling for more than a given threshold, let's try to recover
              const stalledDuration = tnow - this.stalled;
              const bufferLen = bufferInfo.len;
              let nudgeRetry = this.nudgeRetry || 0;
              // have we reached stall deadline ?
              if (bufferLen <= jumpThreshold && stalledDuration > config.lowBufferWatchdogPeriod * 1000) {
                // report stalled error once
                if (!this.stallReported) {
                  this.stallReported = true;
                  logger.warn(`playback stalling in low buffer @${currentTime}`);
                  hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_STALLED_ERROR, fatal: false, buffer : bufferLen});
                  hls.trigger(Event.BUF_STATISTICS, {bufStalledLow: 1});
                }
                // if buffer len is below threshold, try to jump to start of next buffer range if close
                // no buffer available @ currentTime, check if next buffer is close (within a config.maxSeekHole second range)
                var nextBufferStart = bufferInfo.nextStart, delta = nextBufferStart-currentTime;
                if(nextBufferStart &&
                   (delta < config.maxSeekHole) &&
                   (delta > 0)) {
                  this.nudgeRetry = ++nudgeRetry;
                  const nudgeOffset = nudgeRetry * config.nudgeOffset;
                  // next buffer is close ! adjust currentTime to nextBufferStart
                  // this will ensure effective video decoding
                  logger.log(`adjust currentTime from ${media.currentTime} to next buffered @ ${nextBufferStart} + nudge ${nudgeOffset}`);
                  media.currentTime = nextBufferStart + nudgeOffset;
                  // reset stalled so to rearm watchdog timer
                  this.stalled = undefined;
                  hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_SEEK_OVER_HOLE, fatal: false, hole : nextBufferStart + nudgeOffset - currentTime});
                  hls.trigger(Event.BUF_STATISTICS, {bufSeekOverHole: 1});
                }
              } else if (bufferLen > jumpThreshold && stalledDuration > config.highBufferWatchdogPeriod * 1000) {
                // report stalled error once
                if (!this.stallReported) {
                  this.stallReported = true;
                  logger.warn(`playback stalling in high buffer @${currentTime}`);
                  hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_STALLED_ERROR, fatal: false, buffer : bufferLen});
                  hls.trigger(Event.BUF_STATISTICS, {bufStalledHigh: 1});
                }
                // reset stalled so to rearm watchdog timer
                this.stalled = undefined;
                this.nudgeRetry = ++nudgeRetry;
                if (nudgeRetry < config.nudgeMaxRetry) {
                  const currentTime = media.currentTime;
                  const targetTime = currentTime + nudgeRetry * config.nudgeOffset;
                  logger.log(`adjust currentTime from ${currentTime} to ${targetTime}`);
                  // playback stalled in buffered area ... let's nudge currentTime to try to overcome this
                  media.currentTime = targetTime;
                  hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_NUDGE_ON_STALL, fatal: false});
                  hls.trigger(Event.BUF_STATISTICS, {bufNudge: 1});
                } else {
                  logger.error(`still stuck in high buffer @${currentTime} after ${config.nudgeMaxRetry}, raise fatal error`);
                  hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_STALLED_ERROR, fatal: true});
                }
              }
            }
          }
        }
      }
    }
  }

  onFragLoadEmergencyAborted() {
    this.state = State.IDLE;
    this.tick();
  }

  onBufferFlushed() {
    /* after successful buffer flushing, rebuild buffer Range array
      loop through existing buffer range and check if
      corresponding range is still buffered. only push to new array already buffered range
    */
    var newRange = [],range,i;
    for (i = 0; i < this.bufferRange.length; i++) {
      range = this.bufferRange[i];
      if (this.isBuffered((range.start + range.end) / 2)) {
        newRange.push(range);
      }
    }
    this.bufferRange = newRange;

    // handle end of immediate switching if needed
    if (this.immediateSwitch) {
      this.immediateLevelSwitchEnd();
    }
    // move to IDLE once flush complete. this should trigger new fragment loading
    this.state = State.IDLE;
    // reset reference to frag
    this.fragPrevious = null;
  }

  onLevelPtsUpdated(lu) {
    if (!this.levels || this.levels[lu.level].details.live) {
      return;
    }
    for (var level=0; level<this.levels.length; level++) {
      if (level !== lu.level && this.levels[level].details) {
        LevelHelper.mergeDetails(this.levels[lu.level].details, this.levels[level].details);
      }
    }
  }

  swapAudioCodec() {
    this.audioCodecSwap = !this.audioCodecSwap;
  }

  timeRangesToString(r) {
    if (!r) {
      return '[]';
    }
    var log = '', len = r.length;
    for (var i=0; i<len; i++) {
      log += '[' + r.start(i) + ',' + r.end(i) + ']';
    }
    return log;
  }

  computeLivePosition(sliding, levelDetails) {
    let targetLatency = this.config.liveSyncDuration !== undefined ? this.config.liveSyncDuration : this.config.liveSyncDurationCount * levelDetails.targetduration;
    return sliding + Math.max(0, levelDetails.totalduration - targetLatency);
  }
}
export default StreamController;

