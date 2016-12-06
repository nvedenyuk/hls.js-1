/**
 * highly optimized TS demuxer:
 * parse PAT, PMT
 * extract PES packet from audio and video PIDs
 * extract AVC/H264 NAL units and AAC/ADTS samples from PES packet
 * trigger the remuxer upon parsing completion
 * it also tries to workaround as best as it can audio codec switch (HE-AAC to AAC and vice versa), without having to restart the MediaSource.
 * it also controls the remuxing process :
 * upon discontinuity or level switch detection, it will also notifies the remuxer so that it can reset its state.
*/

 import ADTS from './adts';
 import Event from '../events';
 import ExpGolomb from './exp-golomb';
// import Hex from '../utils/hex';
 import {logger} from '../utils/logger';
 import {ErrorTypes, ErrorDetails} from '../errors';
 import '../utils/polyfill';

 class TSDemuxer {

  constructor(observer, remuxerClass, config) {
    this.observer = observer;
    this.remuxerClass = remuxerClass;
    this.config = config;
    this.lastCC = 0;
    this._setEmptyTracks();
    this._clearAllData();
    this.remuxer = new this.remuxerClass(observer, config);
  }

  _setEmptyTracks() {
    this._avcTrack = Object.assign({}, this._avcTrack, {container : 'video/mp2t', type: 'video', samples : [], len : 0, nbNalu : 0, sps: undefined, pps: undefined});
    this._aacTrack = Object.assign({}, this._aacTrack, {container : 'video/mp2t', type: 'audio', samples : [], len : 0});
    this._id3Track = Object.assign({}, this._id3Track, {type: 'id3', samples : [], len : 0});
    this._txtTrack = Object.assign({}, this._txtTrack, {type: 'text', samples: [], len: 0});
    this._avcTrack.sequenceNumber = this._avcTrack.sequenceNumber|0;
    this._aacTrack.sequenceNumber = this._aacTrack.sequenceNumber|0;
    this._id3Track.sequenceNumber = this._id3Track.sequenceNumber|0;
    this._txtTrack.sequenceNumber = this._txtTrack.sequenceNumber|0;
  }

  _clearIDs() {
    this._aacTrack.id = this._avcTrack.id = this._id3Track.id = this._txtTrack.id = -1;
  }

  static probe(data) {
    // a TS fragment should contain at least 3 TS packets, a PAT, a PMT, and one PID, each starting with 0x47
    return (data.length >= 3*188 && data[0] === 0x47 && data[188] === 0x47 && data[2*188] === 0x47);
  }

  switchLevel() {
    // flush end of previous segment
    if (this._avcTrack.samples.length) {
      this.remux(null, false, true, false);
    }
    this.pmtParsed = false;
    this._pmtId = -1;
    this._setEmptyTracks();
    this._clearAllData();
    this._clearIDs();
    // flush any partial content
    this.aacOverFlow = null;
    this.lastAacPTS = null;
    this.remuxer.switchLevel();
  }

  _clearAvcData(){
    return (this._avcData = {data: [], size: 0});
  }

  _clearAacData(){
    return (this._aacData = {data: [], size: 0});
  }

  _clearID3Data(){
    return (this._id3Data = {data: [], size: 0});
  }

  _clearAllData(){
    this._clearAvcData();
    this._clearAacData();
    this._clearID3Data();
  }

  insertDiscontinuity() {
    this.switchLevel();
    this.remuxer.insertDiscontinuity();
  }

  // feed incoming data to the front of the parsing pipeline
  push(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, accurate, first, final, lastSN, flush){
    var avcData = this._avcData, aacData = this._aacData, pes,
        id3Data = this._id3Data, start, len = data.length, stt, pid, atf,
        offset, codecsOnly = this.remuxer.passthrough, unknownPIDs = false;
    this.audioCodec = audioCodec;
    this.videoCodec = videoCodec;
    this.timeOffset = timeOffset;
    this.accurate = accurate;
    this._duration = duration;
    this.contiguous = false;
    if (cc !== this.lastCC) {
      logger.log('discontinuity detected');
      this.insertDiscontinuity();
      this.lastCC = cc;
    }
    if (level !== this.lastLevel) {
      logger.log('level switch detected');
      this.switchLevel();
      this.lastLevel = level;
    }
    if (flush && this.saveAVCSamples) {
      var tAVC = this._avcTrack.samples, tAAC = this._aacTrack.samples;
      var tNextAacPts = this.nextAacPts, tNextAvcDts = this.nextAvcDts;
      logger.log('FLUSH _avcTrack.samples: '+this._avcTrack.samples.length+' fragStartAVCPos: '+this.fragStartAVCPos);
      console.log('FLUSH _avcTrack.samples: '+this._avcTrack.samples.length+' fragStartAVCPos: '+this.fragStartAVCPos);
      this._avcTrack.samples = this.saveAVCSamples;
      this._recalcTrack(this._avcTrack);
      this._aacTrack.samples = this.saveAACSamples;
      this._recalcTrack(this._aacTrack);
      this.nextAacPts = this.nextAvcDts = undefined;
      this.remux(null, false, true, false);
      this.nextAacPts = tNextAacPts;
      this.nextAvcDts = tNextAvcDts;
      this._avcTrack.samples = tAVC;
      this._recalcTrack(this._avcTrack);
      this._aacTrack.samples = tAAC;
      this._recalcTrack(this._aacTrack);
      this.saveAVCSamples = this.saveAACSamples = undefined;
    }
    if (sn === (this.lastSN+1) || !first) {
      this.contiguous = true;
    } else {
      // flush any partial content
      if (this._avcTrack.samples.length) {
        logger.log('flush any partial content');
        this.remux(null, false, true, false);
      }
      this.aacOverFlow = null;
      this._clearAllData();
      this._setEmptyTracks();
    }
    if (first) {
      this.lastContiguous = sn === this.lastSN+1;
      this.fragStats = {keyFrames: 0, dropped: 0, segment: sn, level: level};
      this.remuxAVCCount = this.remuxAACCount = 0;
      this.fragStartPts = this.fragStartDts = this.gopStartDTS = undefined;
      this.fragStartAVCPos = this._avcTrack.samples.length;
      this.fragStartAACPos = this._aacTrack.samples.length;
      this.nextAvcDts = this.contiguous ? this.remuxer.nextAvcDts : this.timeOffset*this.remuxer.PES_TIMESCALE;
    }
    this.currentSN = sn;
    var avcId = this._avcTrack.id,
        aacId = this._aacTrack.id,
        id3Id = this._id3Track.id;

    // don't parse last TS packet if incomplete
    len -= len % 188;
    // loop through TS packets
    for (start = 0; start < len; start += 188) {
      if (data[start] === 0x47) {
        stt = !!(data[start + 1] & 0x40);
        // pid is a 13-bit field starting at the last bit of TS[1]
        pid = ((data[start + 1] & 0x1f) << 8) + data[start + 2];
        atf = (data[start + 3] & 0x30) >> 4;
        // if an adaption field is present, its length is specified by the fifth byte of the TS packet header.
        if (atf > 1) {
          offset = start + 5 + data[start + 4];
          // continue if there is only adaptation field
          if (offset === (start + 188)) {
            continue;
          }
        } else {
          offset = start + 4;
        }

        switch (pid) {
        case avcId:
            if (stt) {
              if ((pes = this._parsePES(avcData))) {
                this._parseAVCPES(pes);
                if (codecsOnly) {
                  // if we have video codec info AND
                  // if audio PID is undefined OR if we have audio codec info,
                  // we have all codec info !
                  if (this._avcTrack.codec && (aacId === -1 || this._aacTrack.codec)) {
                    this.remux(data);
                    return;
                  }
                }
              }
              avcData = this._clearAvcData();
            }
            avcData.data.push(data.subarray(offset, start + 188));
            avcData.size += start + 188 - offset;
            break;
        case aacId:
            if (stt) {
              if ((pes = this._parsePES(aacData))) {
                this._parseAACPES(pes);
                if (codecsOnly) {
                  // here we now that we have audio codec info
                  // if video PID is undefined OR if we have video codec info,
                  // we have all codec infos !
                  if (this._aacTrack.codec && (avcId === -1 || this._avcTrack.codec)) {
                    this.remux(data);
                    return;
                  }
                }
              }
              aacData = this._clearAacData();
            }
            aacData.data.push(data.subarray(offset, start + 188));
            aacData.size += start + 188 - offset;
            break;
        case id3Id:
            if (stt) {
              if ((pes = this._parsePES(id3Data))) {
                this._parseID3PES(pes);
              }
              id3Data = this._clearID3Data();
            }
            id3Data.data.push(data.subarray(offset, start + 188));
            id3Data.size += start + 188 - offset;
            break;
        case 0:
            if (stt) {
              offset += data[offset] + 1;
            }
            this._parsePAT(data, offset);
            break;
        case this._pmtId:
            if (stt) {
              offset += data[offset] + 1;
            }
            this._parsePMT(data, offset);
            avcId = this._avcTrack.id;
            aacId = this._aacTrack.id;
            id3Id = this._id3Track.id;
            if (unknownPIDs && !this.pmtParsed) {
              logger.log('reparse from beginning');
              unknownPIDs = false;
              // we set it to -188, the += 188 in the for loop will reset start to 0
              start = -188;
            }
            this.pmtParsed = true;
            break;
        case 17:
        case 0x1fff:
            break;
        default:
            unknownPIDs = true;
            break;
        }
      } else {
        this.observer.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: false, reason: 'TS packet did not start with 0x47'});
      }
    }
    // parse last PES packet
    if (final) {
      if (avcData.size) {
        this._parseAVCPES(this._parsePES(avcData));
        this._clearAvcData();
      }
      if (aacData.size) {
        this._parseAACPES(this._parsePES(aacData));
        this._clearAacData();
      }
      if (id3Data.size) {
        this._parseID3PES(this._parsePES(id3Data));
        this._clearID3Data();
      }
      this.lastSN = sn;
    }
    if (this.fragStartPts === undefined && this._avcTrack.samples.length>this.fragStartAVCPos) {
      this.fragStartPts = this._avcTrack.samples[this.fragStartAVCPos].pts;
      this.fragStartDts = this._avcTrack.samples[this.fragStartAVCPos].dts;
    }
    if (this.gopStartDTS === undefined && this._avcTrack.samples.length) {
      this.gopStartDTS = this._avcTrack.samples[0].dts;
    }
    this.remux(null, final, final && sn === lastSN, true);
    if (final)
    {
      this.observer.trigger(Event.FRAG_STATISTICS, this.fragStats);
    }
  }

  _recalcTrack(track) {
    if (track.hasOwnProperty('nbNalu')) {
      track.nbNalu = 0;
    }
    track.len = 0;
    for (let i=0; i<track.samples.length; i++) {
      let sample = track.samples[i];
      track.len += ((sample.units&&sample.units.length)|0)+
        ((sample.unit&&sample.unit.length)|0)+(sample.len|0)+
        ((sample.bytes&&sample.bytes.length)|0);
      if (track.hasOwnProperty('nbNalu')) {
        track.nbNalu += sample.units.units.length;
      }
    }
  }

  _filterSamples(track, end, _save) {
    var _new = [];
    for (let i=0; i<track.samples.length; i++) {
      let sample = track.samples[i];
      var sampleTime = sample.dts||sample.pts;
      if (sampleTime <= end) {
        _new.push(sample);
      } else {
        _save.push(sample);
      }
    }
    track.samples = _new;
    this._recalcTrack(track);
  }

  remux(data, final, flush, lastSegment) {
    var _saveAVCSamples = [], _saveAACSamples = [], _saveID3Samples = [],
        _saveTextSamples = [], maxk, samples = this._avcTrack.samples,
        startPTS, endPTS, gopEndDTS;
    let timescale = this.remuxer.PES_TIMESCALE;
    if (samples.length && final) {
      this.fragStats.PTSDTSshift = ((this.fragStartPts === undefined ? samples[0].pts : this.fragStartPts)-(this.fragStartDts === undefined ? samples[0].dts : this.fragStartDts))/timescale;
      let initDTS = this.remuxer._initDTS === undefined ?
        samples[0].dts -timescale * this.timeOffset : this.remuxer._initDTS;
      let startDTS = Math.max(this.remuxer._PTSNormalize((this.gopStartDTS === undefined ? samples[0].dts : this.gopStartDTS) - initDTS,this.nextAvcDts),0);
      let sample = samples[samples.length-1];
      let videoStartPTS = Math.max(this.remuxer._PTSNormalize((this.fragStartPts === undefined ? samples[0].pts : this.fragStartPts) - initDTS,this.nextAvcDts),0)/timescale;
      let videoEndPTS = Math.max(this.remuxer._PTSNormalize(sample.pts - initDTS,this.nextAvcDts),0)/timescale;
      if (Math.abs(startDTS-this.nextAvcDts)>90) {
        videoStartPTS -= (startDTS-this.nextAvcDts)/timescale;
      }
      if ((samples.length+this.remuxAVCCount)>this.fragStartAVCPos+1 && this.fragStartDts !== undefined) {
        videoEndPTS += (sample.dts-this.fragStartDts)/(samples.length+this.remuxAVCCount-this.fragStartAVCPos-1)/timescale;
      }
      startPTS = videoStartPTS;
      endPTS = videoEndPTS;
      if (this._aacTrack.audiosamplerate) {
        let expectedSampleDuration = 1024/this._aacTrack.audiosamplerate;
        let remuxAACCount = this._aacTrack.samples.length;
        let nextAacPTS = (this.lastContiguous !== undefined && this.lastContiguous || this.contiguous && this.remuxAACCount) && this.remuxer.nextAacPts ? this.remuxer.nextAacPts/timescale : this.timeOffset;
        startPTS = Math.max(startPTS, nextAacPTS+(this.fragStartAACPos-this.remuxAACCount)*expectedSampleDuration);
        if (remuxAACCount) {
          endPTS = Math.min(endPTS, nextAacPTS+expectedSampleDuration*remuxAACCount);
        }
        let AVUnsync;
        if ((AVUnsync = endPTS-startPTS+videoStartPTS-videoEndPTS)>0.2) {
          this.fragStats.AVUnsync = AVUnsync;
        }
      }
      // console.log(`parsed total ${startPTS}/${endPTS} video ${videoStartPTS}/${videoEndPTS} shift ${this.fragStats.PTSDTSshift}`);
    }
    if (!flush) {
      // save samples and break by GOP
      for (maxk=samples.length-1; maxk>0; maxk--) {
        if (samples[maxk].key) {
          break;
        }
      }
      if (maxk>0) {
        _saveAVCSamples = samples.slice(maxk);
        this._avcTrack.samples = samples.slice(0, maxk);
        gopEndDTS = this._avcTrack.samples[maxk-1].dts;
        this._recalcTrack(this._avcTrack);
        this._filterSamples(this._aacTrack, gopEndDTS, _saveAACSamples);
        this._filterSamples(this._id3Track, gopEndDTS, _saveID3Samples);
        this._filterSamples(this._txtTrack, gopEndDTS, _saveTextSamples);
      }
      this.saveAVCSamples = samples.slice(0, maxk);
      this.saveAACSamples = this._aacTrack.samples.slice(0, this._aacTrack.samples.length - _saveAACSamples.length);
    }
    if ((flush || final && !this.remuxAVCCount) && this._avcTrack.samples.length+this._aacTrack.samples.length || maxk>0) {
      this.remuxAVCCount += this._avcTrack.samples.length;
      this.remuxAACCount += this._aacTrack.samples.length;
      this.remuxer.remux(this._aacTrack, this._avcTrack, this._id3Track, this._txtTrack, flush && this.nextStartPts ? this.nextStartPts : this.timeOffset,
        flush && !lastSegment || (this.lastContiguous !== undefined ? this.lastContiguous : this.contiguous), this.accurate, data, flush, this.fragStats);
      this.lastContiguous = undefined;
      this.nextStartPts = this.remuxer.endPTS;
      this._avcTrack.samples = _saveAVCSamples;
      this._aacTrack.samples = _saveAACSamples;
      this._id3Track.samples = _saveID3Samples;
      this._txtTrack.samples = _saveTextSamples;
      this._recalcTrack(this._avcTrack);
      this._recalcTrack(this._aacTrack);
      this._recalcTrack(this._id3Track);
      this._recalcTrack(this._txtTrack);
    }
    //notify end of parsing
    if (final) {
      let lastGopPTS = Math.min(this.remuxer.nextAvcDts, this.remuxer.nextAacPts)/timescale;
      this.observer.trigger(Event.FRAG_PARSED, {startPTS: startPTS, endPTS: endPTS, PTSDTSshift: this.fragStats.PTSDTSshift, lastGopPTS: lastGopPTS});
    }
  }

  destroy() {
    this.switchLevel();
    this._initPTS = this._initDTS = undefined;
    this._duration = 0;
  }

  _parsePAT(data, offset) {
    // skip the PSI header and parse the first PMT entry
    this._pmtId  = (data[offset + 10] & 0x1F) << 8 | data[offset + 11];
    //logger.log('PMT PID:'  + this._pmtId);
  }

  _parsePMT(data, offset) {
    var sectionLength, tableEnd, programInfoLength, pid;
    sectionLength = (data[offset + 1] & 0x0f) << 8 | data[offset + 2];
    tableEnd = offset + 3 + sectionLength - 4;
    // to determine where the table is, we have to figure out how
    // long the program info descriptors are
    programInfoLength = (data[offset + 10] & 0x0f) << 8 | data[offset + 11];
    // advance the offset to the first entry in the mapping table
    offset += 12 + programInfoLength;
    while (offset < tableEnd) {
      pid = (data[offset + 1] & 0x1F) << 8 | data[offset + 2];
      switch(data[offset]) {
        // ISO/IEC 13818-7 ADTS AAC (MPEG-2 lower bit-rate audio)
        case 0x0f:
          //logger.log('AAC PID:'  + pid);
          if (this._aacTrack.id === -1) {
            this._aacTrack.id = pid;
          }
          break;
        // Packetized metadata (ID3)
        case 0x15:
          //logger.log('ID3 PID:'  + pid);
          if (this._id3Track.id === -1) {
            this._id3Track.id = pid;
          }
          break;
        // ITU-T Rec. H.264 and ISO/IEC 14496-10 (lower bit-rate video)
        case 0x1b:
          //logger.log('AVC PID:'  + pid);
          if  (this._avcTrack.id === -1) {
            this._avcTrack.id = pid;
          }
          break;
        case 0x24:
          this.fragStats.HEVC = (this.fragStats.HEVC|0)+1;
          logger.warn('HEVC stream type found, not supported for now');
          break;
        default:
          this.fragStats.unknownStream = (this.fragStats.unknownStream|0)+1;
          logger.log('unkown stream type:'  + data[offset]);
        break;
      }
      // move to the next table entry
      // skip past the elementary stream descriptors, if present
      offset += ((data[offset + 3] & 0x0F) << 8 | data[offset + 4]) + 5;
    }
  }

  _parsePES(stream) {
    var i = 0, frag, pesFlags, pesPrefix, pesLen, pesHdrLen, pesData, pesPts, pesDts, payloadStartOffset, data = stream.data;
    // safety check
    if (!stream || stream.size === 0) {
      return null;
    }

    // we might need up to 19 bytes to read PES header
    // if first chunk of data is less than 19 bytes, let's merge it with following ones until we get 19 bytes
    // usually only one merge is needed (and this is rare ...)
    while(data[0].length < 19 && data.length > 1) {
      let newData = new Uint8Array(data[0].length + data[1].length);
      newData.set(data[0]);
      newData.set(data[1], data[0].length);
      data[0] = newData;
      data.splice(1,1);
    }
    //retrieve PTS/DTS from first fragment
    frag = data[0];
    pesPrefix = (frag[0] << 16) + (frag[1] << 8) + frag[2];
    if (pesPrefix === 1) {
      pesLen = (frag[4] << 8) + frag[5];
      if (pesLen && pesLen !== stream.size - 6) {
        return null;
      }
      pesFlags = frag[7];
      if (pesFlags & 0xC0) {
        /* PES header described here : http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
            as PTS / DTS is 33 bit we cannot use bitwise operator in JS,
            as Bitwise operators treat their operands as a sequence of 32 bits */
        pesPts = (frag[9] & 0x0E) * 536870912 +// 1 << 29
          (frag[10] & 0xFF) * 4194304 +// 1 << 22
          (frag[11] & 0xFE) * 16384 +// 1 << 14
          (frag[12] & 0xFF) * 128 +// 1 << 7
          (frag[13] & 0xFE) / 2;
          // check if greater than 2^32 -1
          if (pesPts > 4294967295) {
            // decrement 2^33
            pesPts -= 8589934592;
          }
        if (pesFlags & 0x40) {
          pesDts = (frag[14] & 0x0E ) * 536870912 +// 1 << 29
            (frag[15] & 0xFF ) * 4194304 +// 1 << 22
            (frag[16] & 0xFE ) * 16384 +// 1 << 14
            (frag[17] & 0xFF ) * 128 +// 1 << 7
            (frag[18] & 0xFE ) / 2;
          // check if greater than 2^32 -1
          if (pesDts > 4294967295) {
            // decrement 2^33
            pesDts -= 8589934592;
          }
        } else {
          pesDts = pesPts;
        }
      }
      pesHdrLen = frag[8];
      payloadStartOffset = pesHdrLen + 9;

      stream.size -= payloadStartOffset;
      //reassemble PES packet
      pesData = new Uint8Array(stream.size);
      while (data.length) {
        frag = data.shift();
        var len = frag.byteLength;
        if (payloadStartOffset) {
          if (payloadStartOffset > len) {
            // trim full frag if PES header bigger than frag
            payloadStartOffset-=len;
            continue;
          } else {
            // trim partial frag if PES header smaller than frag
            frag = frag.subarray(payloadStartOffset);
            len-=payloadStartOffset;
            payloadStartOffset = 0;
          }
        }
        pesData.set(frag, i);
        i+=len;
      }
      if (pesLen) {
        // payload size : remove PES header + PES extension
        pesLen -= pesHdrLen+3;
      }
      return {data: pesData, pts: pesPts, dts: pesDts, len: pesLen};
    } else {
      return null;
    }
  }

  _parseAVCPES(pes) {
    var track = this._avcTrack,
        samples = track.samples,
        units = this._parseAVCNALu(pes.data),
        units2 = [],
        debug = false,
        key = false,
        length = 0,
        expGolombDecoder,
        avcSample,
        push,
        hlsConfig = this.config,
        i;
    // no NALu found
    if (units.length === 0 && samples.length > 0) {
      // append pes.data to previous NAL unit
      var lastavcSample = samples[samples.length - 1];
      var lastUnit = lastavcSample.units.units[lastavcSample.units.units.length - 1];
      var tmp = new Uint8Array(lastUnit.data.byteLength + pes.data.byteLength);
      tmp.set(lastUnit.data, 0);
      tmp.set(pes.data, lastUnit.data.byteLength);
      lastUnit.data = tmp;
      lastavcSample.units.length += pes.data.byteLength;
      track.len += pes.data.byteLength;
    }
    //free pes.data to save up some memory
    pes.data = null;
    var debugString = '';

    units.forEach(unit => {
      switch(unit.type) {
        //NDR
        case 1:
          push = true;
          if(debug) {
            debugString += 'NDR ';
          }
          break;
        //IDR
        case 5:
          push = true;
          if(debug) {
            debugString += 'IDR ';
          }
          key = true;
          break;
        //SEI
        case 6:
          push = true;
          if(debug) {
            debugString += 'SEI ';
          }
          expGolombDecoder = new ExpGolomb(this.discardEPB(unit.data));

          // skip frameType
          expGolombDecoder.readUByte();

          var payloadType = 0;
          var payloadSize = 0;
          var endOfCaptions = false;
          var b = 0;

          while (!endOfCaptions && expGolombDecoder.wholeBytesAvailable() > 1) {
            payloadType = 0;
            do {
               b = expGolombDecoder.readUByte();
               payloadType += b;
            } while (b === 0xFF);
            // Parse payload size.
            payloadSize = 0;
            do {
               b = expGolombDecoder.readUByte();
               payloadSize += b;
            } while (b === 0xFF);

            // if SEI recovery_point has been found mark as keyframe
            if (!hlsConfig.disableSEIkeyframes) {
                key = key || payloadType === 6;
            }

            // TODO: there can be more than one payload in an SEI packet...
            // TODO: need to read type and size in a while loop to get them all
            if (payloadType === 4 && expGolombDecoder.wholeBytesAvailable() !== 0) {

              endOfCaptions = true;

              var countryCode = expGolombDecoder.readUByte();

              if (countryCode === 181) {
                var providerCode = expGolombDecoder.readUShort();

                if (providerCode === 49) {
                  var userStructure = expGolombDecoder.readUInt();

                  if (userStructure === 0x47413934) {
                    var userDataType = expGolombDecoder.readUByte();

                    // Raw CEA-608 bytes wrapped in CEA-708 packet
                    if (userDataType === 3) {
                      var firstByte = expGolombDecoder.readUByte();
                      var secondByte = expGolombDecoder.readUByte();

                      var totalCCs = 31 & firstByte;
                      var byteArray = [firstByte, secondByte];

                      for (i = 0; i < totalCCs; i++) {
                        // 3 bytes per CC
                        byteArray.push(expGolombDecoder.readUByte());
                        byteArray.push(expGolombDecoder.readUByte());
                        byteArray.push(expGolombDecoder.readUByte());
                      }

                      this._insertSampleInOrder(this._txtTrack.samples, { type: 3, pts: pes.pts, bytes: byteArray });
                    }
                  }
                }
              }
            }
            else if (payloadSize < expGolombDecoder.wholeBytesAvailable())
            {
              for (i = 0; i<payloadSize; i++)
              {
                expGolombDecoder.readUByte();
              }
            }
          }
          break;
        //SPS
        case 7:
          push = true;
          if(debug) {
            debugString += 'SPS ';
          }
          if(!track.sps) {
            expGolombDecoder = new ExpGolomb(unit.data);
            var config = expGolombDecoder.readSPS();
            track.width = config.width;
            track.height = config.height;
            track.sps = [unit.data];
            track.duration = this._duration;
            var codecarray = unit.data.subarray(1, 4);
            var codecstring = 'avc1.';
            for (i = 0; i < 3; i++) {
              var h = codecarray[i].toString(16);
              if (h.length < 2) {
                h = '0' + h;
              }
              codecstring += h;
            }
            track.codec = codecstring;
          }
          break;
        //PPS
        case 8:
          push = true;
          if(debug) {
            debugString += 'PPS ';
          }
          if (!track.pps) {
            track.pps = [unit.data];
          }
          break;
        case 9:
          push = false;
          if(debug) {
            debugString += 'AUD ';
          }
          break;
        default:
          push = false;
          debugString += 'unknown NAL ' + unit.type + ' ';
          break;
      }
      if(push) {
        units2.push(unit);
        length+=unit.data.byteLength;
      }
    });
    if(debug || debugString.length) {
      logger.log(debugString);
    }
    //build sample from PES
    // Annex B to MP4 conversion to be done
    if (units2.length) {
      // only push AVC sample if keyframe already found in this fragment OR
      //    keyframe found in last fragment (track.sps) AND
      //        samples already appended (we already found a keyframe in this fragment) OR fragment is contiguous
      if (key === true ||
          (track.sps && (samples.length || this.contiguous))) {
        avcSample = {units: { units : units2, length : length}, pts: pes.pts, dts: pes.dts, key: key};
        if (key) {
          this.fragStats.keyFrames++;
        }
        // logger.log(`avcSample ${units2.length} ${length} ${pes.dts} ${key}`);
        samples.push(avcSample);
        track.len += length;
        track.nbNalu += units2.length;
      }
      else {
        this.fragStats.dropped++;
      }
    }
  }

  _insertSampleInOrder(arr, data) {
    var len = arr.length;
    if (len > 0) {
      if (data.pts >= arr[len-1].pts)
      {
        arr.push(data);
      }
      else {
        for (var pos = len - 1; pos >= 0; pos--) {
          if (data.pts < arr[pos].pts) {
            arr.splice(pos, 0, data);
            break;
          }
        }
      }
    }
    else {
      arr.push(data);
    }
  }

  _parseAVCNALu(array) {
    var i = 0, len = array.byteLength, value, overflow, state = 0;
    var units = [], unit, unitType, lastUnitStart, lastUnitType;
    //logger.log('PES:' + Hex.hexDump(array));
    while (i < len) {
      value = array[i++];
      // finding 3 or 4-byte start codes (00 00 01 OR 00 00 00 01)
      switch (state) {
        case 0:
          if (value === 0) {
            state = 1;
          }
          break;
        case 1:
          if( value === 0) {
            state = 2;
          } else {
            state = 0;
          }
          break;
        case 2:
        case 3:
          if( value === 0) {
            state = 3;
          } else if (value === 1 && i < len) {
            unitType = array[i] & 0x1f;
            //logger.log('find NALU @ offset:' + i + ',type:' + unitType);
            if (lastUnitStart) {
              unit = {data: array.subarray(lastUnitStart, i - state - 1), type: lastUnitType};
              //logger.log('pushing NALU, type/size:' + unit.type + '/' + unit.data.byteLength);
              units.push(unit);
            } else {
              // If NAL units are not starting right at the beginning of the PES packet, push preceding data into previous NAL unit.
              overflow  = i - state - 1;
              if (overflow) {
                let track = this._avcTrack,
                    samples = track.samples;
                //logger.log('first NALU found with overflow:' + overflow);
                if (samples.length) {
                  let lastavcSample = samples[samples.length - 1],
                      lastUnits = lastavcSample.units.units,
                      lastUnit = lastUnits[lastUnits.length - 1],
                      tmp = new Uint8Array(lastUnit.data.byteLength + overflow);
                  tmp.set(lastUnit.data, 0);
                  tmp.set(array.subarray(0, overflow), lastUnit.data.byteLength);
                  lastUnit.data = tmp;
                  lastavcSample.units.length += overflow;
                  track.len += overflow;
                }
              }
            }
            lastUnitStart = i;
            lastUnitType = unitType;
            state = 0;
          } else {
            state = 0;
          }
          break;
        default:
          break;
      }
    }
    if (lastUnitStart) {
      unit = {data: array.subarray(lastUnitStart, len), type: lastUnitType};
      units.push(unit);
      //logger.log('pushing NALU, type/size:' + unit.type + '/' + unit.data.byteLength);
    }
    return units;
  }

  /**
   * remove Emulation Prevention bytes from a RBSP
   */
  discardEPB(data) {
    var length = data.byteLength,
        EPBPositions = [],
        i = 1,
        newLength, newData;

    // Find all `Emulation Prevention Bytes`
    while (i < length - 2) {
      if (data[i] === 0 &&
          data[i + 1] === 0 &&
          data[i + 2] === 0x03) {
        EPBPositions.push(i + 2);
        i += 2;
      } else {
        i++;
      }
    }

    // If no Emulation Prevention Bytes were found just return the original
    // array
    if (EPBPositions.length === 0) {
      return data;
    }

    // Create a new array to hold the NAL unit data
    newLength = length - EPBPositions.length;
    newData = new Uint8Array(newLength);
    var sourceIndex = 0;

    for (i = 0; i < newLength; sourceIndex++, i++) {
      if (sourceIndex === EPBPositions[0]) {
        // Skip this byte
        sourceIndex++;
        // Remove this position index
        EPBPositions.shift();
      }
      newData[i] = data[sourceIndex];
    }
    return newData;
  }

  _parseAACPES(pes) {
    var track = this._aacTrack,
        data = pes.data,
        pts = pes.pts,
        startOffset = 0,
        duration = this._duration,
        audioCodec = this.audioCodec,
        aacOverFlow = this.aacOverFlow,
        lastAacPTS = this.lastAacPTS,
        config, frameLength, frameDuration, frameIndex, offset, headerLength, stamp, len, aacSample;
    if (aacOverFlow) {
      var tmp = new Uint8Array(aacOverFlow.byteLength + data.byteLength);
      tmp.set(aacOverFlow, 0);
      tmp.set(data, aacOverFlow.byteLength);
      //logger.log(`AAC: append overflowing ${aacOverFlow.byteLength} bytes to beginning of new PES`);
      data = tmp;
    }
    // look for ADTS header (0xFFFx)
    for (offset = startOffset, len = data.length; offset < len - 1; offset++) {
      if ((data[offset] === 0xff) && (data[offset+1] & 0xf0) === 0xf0) {
        break;
      }
    }
    // if ADTS header does not start straight from the beginning of the PES payload, raise an error
    if (offset) {
      var reason, fatal;
      if (offset < len - 1) {
        reason = `AAC PES did not start with ADTS header,offset:${offset}`;
        fatal = false;
      } else {
        reason = 'no ADTS header found in AAC PES';
        fatal = true;
      }
      this.observer.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: fatal, reason: reason});
      if (fatal) {
        return;
      }
    }
    config = ADTS.getAudioConfig(this.observer,data, offset, audioCodec);
    if (track.audiosamplerate !== config.audiosamplerate || track.codec !== config.codec) {
      track.config = config.config;
      track.audiosamplerate = config.samplerate;
      track.channelCount = config.channelCount;
      track.codec = config.codec;
      track.duration = duration;
      logger.log(`parsed codec:${track.codec},rate:${config.samplerate},nb channel:${config.channelCount}`);
    }
    frameIndex = 0;
    frameDuration = 1024 * 90000 / track.audiosamplerate;

    // if last AAC frame is overflowing, we should ensure timestamps are contiguous:
    // first sample PTS should be equal to last sample PTS + frameDuration
    if(aacOverFlow && lastAacPTS) {
      var newPTS = lastAacPTS+frameDuration;
      if(Math.abs(newPTS-pts) > 1) {
        logger.log(`AAC: align PTS for overlapping frames by ${Math.round((newPTS-pts)/90)}`);
        pts=newPTS;
      }
    }

    while ((offset + 5) < len) {
      // The protection skip bit tells us if we have 2 bytes of CRC data at the end of the ADTS header
      headerLength = (!!(data[offset + 1] & 0x01) ? 7 : 9);
      // retrieve frame size
      frameLength = ((data[offset + 3] & 0x03) << 11) |
                     (data[offset + 4] << 3) |
                    ((data[offset + 5] & 0xE0) >>> 5);
      frameLength  -= headerLength;
      //stamp = pes.pts;

      if ((frameLength > 0) && ((offset + headerLength + frameLength) <= len)) {
        stamp = pts + frameIndex * frameDuration;
        //logger.log(`AAC frame, offset/length/total/pts:${offset+headerLength}/${frameLength}/${data.byteLength}/${(stamp/90).toFixed(0)}`);
        aacSample = {unit: data.subarray(offset + headerLength, offset + headerLength + frameLength), pts: stamp, dts: stamp};
        track.samples.push(aacSample);
        track.len += frameLength;
        offset += frameLength + headerLength;
        frameIndex++;
        // look for ADTS header (0xFFFx)
        for ( ; offset < (len - 1); offset++) {
          if ((data[offset] === 0xff) && ((data[offset + 1] & 0xf0) === 0xf0)) {
            break;
          }
        }
      } else {
        break;
      }
    }
    if (offset < len) {
      aacOverFlow = data.subarray(offset, len);
      //logger.log(`AAC: overflow detected:${len-offset}`);
    } else {
      aacOverFlow = null;
    }
    this.aacOverFlow = aacOverFlow;
    this.lastAacPTS = stamp;
  }

  _parseID3PES(pes) {
    this._id3Track.samples.push(pes);
  }
}

export default TSDemuxer;
