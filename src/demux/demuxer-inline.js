/*  inline demuxer.
 *   probe fragments and instantiate appropriate demuxer depending on content type (TSDemuxer, AACDemuxer, ...)
 */

import Event from '../events';
import {ErrorTypes, ErrorDetails} from '../errors';
import AACDemuxer from '../demux/aacdemuxer';
import TSDemuxer from '../demux/tsdemuxer';
import MP4Remuxer from '../remux/mp4-remuxer';
import PassThroughRemuxer from '../remux/passthrough-remuxer';

class DemuxerInline {

  constructor(hls,typeSupported, config=null) {
    var _this = this;
    this.hls = hls;
    this.config = this.hls.config || config;
    this.typeSupported = typeSupported;
    this.timeOffset = 0;
    this.onFragParsingData = function(ev, data) {
      if (data.type === 'video' && !data.flush) {
        // sync on video chunks
        _this.timeOffset += data.endDTS-data.startDTS;
      }
    };
    this.hls.on(Event.FRAG_PARSING_DATA, this.onFragParsingData);
  }

  destroy() {
    var demuxer = this.demuxer;
    if (demuxer) {
      demuxer.destroy();
    }
    this.hls.off(Event.FRAG_PARSING_DATA, this.onFragParsingData);
  }

  push(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration, accurate, first, final, lastSN) {
    var demuxer = this.demuxer;
    if (!demuxer) {
      var hls = this.hls;
      // probe for content type
      if (TSDemuxer.probe(data)) {
        if (this.typeSupported.mp2t === true) {
          demuxer = new TSDemuxer(hls, PassThroughRemuxer, this.config);
        } else {
          demuxer = new TSDemuxer(hls, MP4Remuxer, this.config);
        }
      } else if(AACDemuxer.probe(data)) {
        demuxer = new AACDemuxer(hls, MP4Remuxer, this.config);
      } else {
        hls.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: true, reason: 'no demux matching with content found'});
        return;
      }
      this.demuxer = demuxer;
    }
    if (first) {
      this.timeOffset = timeOffset;
    }
    demuxer.push(data,audioCodec,videoCodec,this.timeOffset,cc,level,sn,duration,accurate,first,final,lastSN);
  }
}

export default DemuxerInline;
