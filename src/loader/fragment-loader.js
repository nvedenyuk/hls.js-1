/*
 * Fragment Loader
*/

import Event from '../events';
import EventHandler from '../event-handler';
import {ErrorTypes, ErrorDetails} from '../errors';

class FragmentLoader extends EventHandler {

  constructor(hls) {
    super(hls, Event.FRAG_LOADING);
  }

  destroy() {
    if (this.loader) {
      this.loader.destroy();
      this.loader = null;
    }
    this.firstChunk = true;
    EventHandler.prototype.destroy.call(this);
  }

  onFragLoading(data) {
    var frag = data.frag;
    this.frag = frag;
    this.frag.loaded = 0;
    this.firstChunk = true;
    var config = this.hls.config;
    frag.loader = this.loader = typeof(config.fLoader) !== 'undefined' ? new config.fLoader(config) : new config.loader(config);
    this.loader.load(frag.url, 'arraybuffer', this.loadsuccess.bind(this), this.loaderror.bind(this), this.loadtimeout.bind(this), config.fragLoadingTimeOut, 1, 0, this.loadprogress.bind(this), frag, this.loadchunk.bind(this));
  }

  loadchunk(event, stats) {
    var payload = event.currentTarget.response;
    payload.first = this.firstChunk;
    this.firstChunk = false;
    this.hls.trigger(Event.FRAG_CHUNK_LOADED, {payload: payload, frag: this.frag, stats: stats});
  }

  loadsuccess(event, stats) {
    var payload = event.currentTarget.response;
    payload.final = true;
    stats.length = payload.byteLength;
    this.hls.trigger(Event.FRAG_LOADED, {frag: this.frag, stats: stats});
    this.loadchunk(event, stats);
    this.firstChunk = true;
    // detach fragment loader on load success
    this.frag.loader = undefined;
  }

  loaderror(event) {
    if (this.loader) {
      this.loader.abort();
    }
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.FRAG_LOAD_ERROR, fatal: false, frag: this.frag, response: event});
  }

  loadtimeout() {
    if (this.loader) {
      this.loader.abort();
    }
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.FRAG_LOAD_TIMEOUT, fatal: false, frag: this.frag});
  }

  loadprogress(stats) {
    this.frag.loaded = stats.loaded;
    this.hls.trigger(Event.FRAG_LOAD_PROGRESS, {frag: this.frag, stats: stats});
  }
}

export default FragmentLoader;
