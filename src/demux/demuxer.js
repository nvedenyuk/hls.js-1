import Event from '../events';
import DemuxerInline from '../demux/demuxer-inline';
import DemuxerWorker from '../demux/demuxer-worker';
import {logger} from '../utils/logger';
import Decrypter from '../crypt/decrypter';

class Demuxer {

  constructor(hls) {
    this.hls = hls;
    this.trail = new Uint8Array(0);
    var typeSupported = {
      mp4 : MediaSource.isTypeSupported('video/mp4'),
      mp2t : hls.config.enableMP2TPassThrough && MediaSource.isTypeSupported('video/mp2t')
    };
    if (hls.config.enableWorker && (typeof(Worker) !== 'undefined')) {
        logger.log('demuxing in webworker');
        try {
          var work = require('webworkify');
          this.w = work(DemuxerWorker);
          this.onwmsg = this.onWorkerMessage.bind(this);
          this.w.addEventListener('message', this.onwmsg);
          this.w.postMessage({cmd: 'init', typeSupported : typeSupported, config: JSON.stringify(hls.config)});
        } catch(err) {
          logger.error('error while initializing DemuxerWorker, fallback on DemuxerInline');
          this.demuxer = new DemuxerInline(hls,typeSupported);
        }
      } else {
        this.demuxer = new DemuxerInline(hls,typeSupported);
      }
      this.demuxInitialized = true;
  }

  destroy() {
    if (this.w) {
      this.w.removeEventListener('message', this.onwmsg);
      this.w.terminate();
      this.w = null;
    } else {
      this.demuxer.destroy();
      this.demuxer = null;
    }
    if (this.decrypter) {
      this.decrypter.destroy();
      this.decrypter = null;
    }
  }

  pushDecrypted(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, accurate, first, final, lastSN, flush) {
    if (this.w) {
      // post fragment payload as transferable objects (no copy)
      this.w.postMessage({cmd: 'demux', data: data, audioCodec: audioCodec, videoCodec: videoCodec, timeOffset: timeOffset, cc: cc, level: level, sn : sn, duration: duration, accurate: accurate, first: first, final: final, lastSN: lastSN, flush: flush}, [data]);
    } else {
      this.demuxer.push(new Uint8Array(data), audioCodec, videoCodec, timeOffset, cc, level, sn, duration, accurate, first, final, lastSN);
    }
  }

  push(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, decryptdata, accurate, lastSN, flush) {
    if (data.first) {
      this.trail = new Uint8Array(0);
      this.trail.first = true;
    }
    var traillen = this.trail.length;
    // 752 = 4*188. We need number of bytes to be multiplier of 16 to
    // perform chained AES decryption
    if (traillen || (data.byteLength+traillen)%752) {
      var final = data.final, first = data.first||this.trail.first||false;
      // add trailing bytes
      var newlen = data.byteLength+traillen;
      if (!final) {
        // at final chunk we sent all pending data
        newlen -= newlen%752;
      }
      var olddata = new Uint8Array(data);
      var newdata = new Uint8Array(newlen);
      var newtrail = new Uint8Array(data.byteLength+traillen-newlen);
      if (newlen) {
        newdata.set(this.trail);
        newdata.set(olddata.subarray(0, newlen-traillen), traillen);
      }
      if (newtrail.length) {
        if (newlen) {
          newtrail.set(olddata.subarray(-newtrail.length));
        } else {
          newtrail.set(this.trail);
          newtrail.set(olddata, traillen);
          newtrail.first = first;
        }
      }
      olddata = null;
      this.trail = newtrail;
      if (!newdata.length) {
        return;
      }
      data = newdata.buffer;
      data.final = final;
      data.first = first;
      newdata = null;
    }
    if ((data.byteLength > 0) && (decryptdata != null) && (decryptdata.key != null) && (decryptdata.method === 'AES-128')) {
      if (this.decrypter == null) {
        this.decrypter = new Decrypter(this.hls);
      }

      var localthis = this;
      this.decrypter.decrypt(data, decryptdata.key, data.first&&decryptdata.iv, function(decryptedData){
        localthis.pushDecrypted(decryptedData, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, accurate, !!data.first, !!data.final, lastSN, flush);
      });
    } else {
      this.pushDecrypted(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, accurate, !!data.first, !!data.final, lastSN, flush);
    }
  }

  onWorkerMessage(ev) {
    var data = ev.data;
    switch(data.event) {
      case Event.FRAG_PARSING_INIT_SEGMENT:
        var obj = {};
        obj.tracks = data.tracks;
        obj.unique = data.unique;
        this.hls.trigger(Event.FRAG_PARSING_INIT_SEGMENT, obj);
        break;
      case Event.FRAG_PARSING_DATA:
        this.hls.trigger(Event.FRAG_PARSING_DATA,{
          data1: new Uint8Array(data.data1),
          data2: new Uint8Array(data.data2),
          startPTS: data.startPTS,
          endPTS: data.endPTS,
          startDTS: data.startDTS,
          endDTS: data.endDTS,
          type: data.type,
          nb: data.nb
        });
        break;
      case Event.FRAG_PARSING_METADATA:
        this.hls.trigger(Event.FRAG_PARSING_METADATA, {
          samples: data.samples
        });
        break;
      case Event.FRAG_PARSING_USERDATA:
        this.hls.trigger(Event.FRAG_PARSING_USERDATA, {
          samples: data.samples
        });
        break;
      default:
        this.hls.trigger(data.event, data.data);
        break;
    }
  }
}

export default Demuxer;

