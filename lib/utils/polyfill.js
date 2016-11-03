"use strict";

if (!ArrayBuffer.prototype.slice) {
  ArrayBuffer.prototype.slice = function (start, end) {
    var that = new Uint8Array(this);
    if (end === undefined) {
      end = that.length;
    }
    var result = new ArrayBuffer(end - start);
    var resultArray = new Uint8Array(result);
    for (var i = 0; i < resultArray.length; i++) {
      resultArray[i] = that[i + start];
    }
    return result;
  };
}
if (!Object.assign) {
  Object.assign = function (obj) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (!source) {
        continue;
      }
      for (var prop in source) {
        if (source.hasOwnProperty(prop)) {
          obj[prop] = source[prop];
        }
      }
    }
    return obj;
  };
}