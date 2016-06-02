/*
 * AES128 decryption.
 */

import AES128Decrypter from './aes128-decrypter';
import {ErrorTypes, ErrorDetails} from '../errors';
import {logger} from '../utils/logger';

class Decrypter {

  constructor(hls) {
    this.hls = hls;
    this.iv = null;
    try {
      const browserCrypto = window ? window.crypto : crypto;
      this.subtle = browserCrypto.subtle || browserCrypto.webkitSubtle;
      this.disableWebCrypto = !this.subtle;
    } catch (e) {
      this.disableWebCrypto = true;
    }
  }

  destroy() {
  }

  decrypt(data, key, iv, callback) {
    if (this.disableWebCrypto && this.hls.config.enableSoftwareAES) {
      this.decryptBySoftware(data, key, iv, callback);
    } else {
      this.decryptByWebCrypto(data, key, iv, callback);
    }
  }

  decryptByWebCrypto(data, key, iv, callback) {
    logger.log('decrypting by WebCrypto API');

    this.subtle.importKey('raw', key, { name : 'AES-CBC', length : 128 }, false, ['decrypt']).
      then((importedKey) => {
        this.subtle.decrypt({ name : 'AES-CBC', iv : iv.buffer }, importedKey, data).
          then(callback).
          catch ((err) => {
            this.onWebCryptoError(err, data, key, iv, callback);
          });
      }).
    catch ((err) => {
      this.onWebCryptoError(err, data, key, iv, callback);
    });
  }

  decryptBySoftware(data, key8, iv8, callback) {
    logger.log('decrypting by JavaScript Implementation');

    var view = new DataView(key8.buffer);
    var key = new Uint32Array([
        view.getUint32(0),
        view.getUint32(4),
        view.getUint32(8),
        view.getUint32(12)
    ]);

    if (iv8) {
      view = new DataView(iv8.buffer);
      this.iv = new Uint32Array([
          view.getUint32(0),
          view.getUint32(4),
          view.getUint32(8),
          view.getUint32(12)
      ]);
    }
    var decrypter = new AES128Decrypter(key, this.iv);
    var ivview = new DataView(data), len = data.byteLength;
    // save initvector for the next chunk
    this.iv = new Uint32Array([
        ivview.getUint32(len-16),
        ivview.getUint32(len-12),
        ivview.getUint32(len-8),
        ivview.getUint32(len-4)
    ]);
    callback(decrypter.decrypt(data).buffer);
  }

  onWebCryptoError(err, data, key, iv, callback) {
    if (this.hls.config.enableSoftwareAES) {
      logger.log('disabling to use WebCrypto API');
      this.disableWebCrypto = true;
      this.decryptBySoftware(data, key, iv, callback);
    }
    else {
      logger.error(`decrypting error : ${err.message}`);
      this.hls.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, details : ErrorDetails.FRAG_DECRYPT_ERROR, fatal : true, reason : err.message});
    }
  }

}

export default Decrypter;
