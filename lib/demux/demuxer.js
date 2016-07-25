'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _events = require('../events');

var _events2 = _interopRequireDefault(_events);

var _demuxerInline = require('../demux/demuxer-inline');

var _demuxerInline2 = _interopRequireDefault(_demuxerInline);

var _demuxerWorker = require('../demux/demuxer-worker');

var _demuxerWorker2 = _interopRequireDefault(_demuxerWorker);

var _logger = require('../utils/logger');

var _decrypter = require('../crypt/decrypter');

var _decrypter2 = _interopRequireDefault(_decrypter);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Demuxer = function () {
  function Demuxer(hls) {
    _classCallCheck(this, Demuxer);

    this.hls = hls;
    this.trail = new Uint8Array(0);
    var typeSupported = {
      mp4: MediaSource.isTypeSupported('video/mp4'),
      mp2t: hls.config.enableMP2TPassThrough && MediaSource.isTypeSupported('video/mp2t')
    };
    if (hls.config.enableWorker && typeof Worker !== 'undefined') {
      _logger.logger.log('demuxing in webworker');
      try {
        var work = require('webworkify');
        this.w = work(_demuxerWorker2.default);
        this.onwmsg = this.onWorkerMessage.bind(this);
        this.w.addEventListener('message', this.onwmsg);
        this.w.postMessage({ cmd: 'init', typeSupported: typeSupported, config: JSON.stringify(hls.config) });
      } catch (err) {
        _logger.logger.error('error while initializing DemuxerWorker, fallback on DemuxerInline');
        this.demuxer = new _demuxerInline2.default(hls, typeSupported);
      }
    } else {
      this.demuxer = new _demuxerInline2.default(hls, typeSupported);
    }
    this.demuxInitialized = true;
  }

  _createClass(Demuxer, [{
    key: 'destroy',
    value: function destroy() {
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
  }, {
    key: 'pushDecrypted',
    value: function pushDecrypted(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, final) {
      if (this.w) {
        // post fragment payload as transferable objects (no copy)
        this.w.postMessage({ cmd: 'demux', data: data, audioCodec: audioCodec, videoCodec: videoCodec, timeOffset: timeOffset, cc: cc, level: level, sn: sn, duration: duration, final: final }, [data]);
      } else {
        this.demuxer.push(new Uint8Array(data), audioCodec, videoCodec, timeOffset, cc, level, sn, duration, final);
      }
    }
  }, {
    key: 'push',
    value: function push(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, decryptdata) {
      if (data.first) {
        this.trail = new Uint8Array(0);
        this.trail.first = true;
      }
      var traillen = this.trail.length;
      // 752 = 4*188. We need number of bytes to be multiplier of 16 to
      // perform chained AES decryption
      if (traillen || (data.byteLength + traillen) % 752) {
        var final = data.final,
            first = data.first || this.trail.first || false;
        // add trailing bytes
        var newlen = data.byteLength + traillen;
        if (!final) {
          // at final chunk we sent all pending data
          newlen -= newlen % 752;
        }
        var olddata = new Uint8Array(data);
        var newdata = new Uint8Array(newlen);
        var newtrail = new Uint8Array(data.byteLength + traillen - newlen);
        if (newlen) {
          newdata.set(this.trail);
          newdata.set(olddata.subarray(0, newlen - traillen), traillen);
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
      if (data.byteLength > 0 && decryptdata != null && decryptdata.key != null && decryptdata.method === 'AES-128') {
        if (this.decrypter == null) {
          this.decrypter = new _decrypter2.default(this.hls);
        }

        var localthis = this;
        this.decrypter.decrypt(data, decryptdata.key, data.first && decryptdata.iv, function (decryptedData) {
          localthis.pushDecrypted(decryptedData, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, !!data.final);
        });
      } else {
        this.pushDecrypted(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, !!data.final);
      }
    }
  }, {
    key: 'onWorkerMessage',
    value: function onWorkerMessage(ev) {
      var data = ev.data;
      //console.log('onWorkerMessage:' + data.event);
      switch (data.event) {
        case _events2.default.FRAG_PARSING_INIT_SEGMENT:
          var obj = {};
          obj.tracks = data.tracks;
          obj.unique = data.unique;
          this.hls.trigger(_events2.default.FRAG_PARSING_INIT_SEGMENT, obj);
          break;
        case _events2.default.FRAG_PARSING_DATA:
          this.hls.trigger(_events2.default.FRAG_PARSING_DATA, {
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
        case _events2.default.FRAG_PARSING_METADATA:
          this.hls.trigger(_events2.default.FRAG_PARSING_METADATA, {
            samples: data.samples
          });
          break;
        case _events2.default.FRAG_PARSING_USERDATA:
          this.hls.trigger(_events2.default.FRAG_PARSING_USERDATA, {
            samples: data.samples
          });
          break;
        default:
          this.hls.trigger(data.event, data.data);
          break;
      }
    }
  }]);

  return Demuxer;
}();

exports.default = Demuxer;