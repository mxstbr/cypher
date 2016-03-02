/** @babel */

import fs from 'fs';
import path from 'path';

import NylasStore from 'nylas-store';
import {Utils, FileDownloadStore, MessageBodyProcessor} from 'nylas-exports';

import EmailPGPFileDownloadStoreWatcher from '../email-pgp-file-download-store-watcher';
import MessageActions from '../actions/email-pgp-actions';

import DecryptionRequest from '../tasks/decryption-request';
import FlowError from '../../utils/flow-error';
import KeyStore from '../../worker/kbpgp/key-store';
import Logger from '../../utils/Logger';

import smalltalk from 'smalltalk';

/**
 * The main management class for the PGP plugin for the decryption function.
 * Handles almost all the decrpytion processing.
 *
 * THANK YOU GPGTOOLS! The `MimePart+GPGMail.m` is such a good guide to PGP
 * mail decryption.
 *
 * @class EmailPGPStore
 */
class EmailPGPStore extends NylasStore {
  constructor() {
    super();

    // Store status of message decryption for MessageLoaderHeader
    this._state = new Map();

    // Binding `this` to each method that uses `this`
    this.shouldDecryptMessage = this.shouldDecryptMessage.bind(this);
    this._decryptMessage = this._decryptMessage.bind(this);
    this._retryMessage = this._retryMessage.bind(this);
    this.setState = this.setState.bind(this);
    this.mainDecrypt = this.mainDecrypt.bind(this);
    this.getAttachmentAndKey = this.getAttachmentAndKey.bind(this);
    this.retrievePGPAttachment = this.retrievePGPAttachment.bind(this);
    this._decryptAndResetCache = this._decryptAndResetCache.bind(this);

    this.log = Logger.create(`EmailPGPStore`);

    this.listenTo(MessageActions.decrypt, this._decryptMessage);
    this.listenTo(MessageActions.retry, this._retryMessage);

    global.$pgpEmailPGPStore = this;
  }

  /**
   * The quick check method if the message has a valid attachment.
   *
   * Returns true only if there is at least one attachment and one of the
   * attachments has the 'pgp', 'gpg', or 'asc' extensions.
   *
   * GPGTools (and other clients) send two attachments, where the first
   * "metadata" attachment contains the string "Version: 1" and the second
   * attachment is the encrypted message.
   *
   * Though, the "metadata" attachment's `contentType` is
   * 'application/pgp-encrypted' and the encrypted message attachment is
   * 'application/octet-stream', which is annoying to deal with.
   *
   * @param {object} message - the message to check for appropriate attachment
   */
  shouldDecryptMessage(message) {
    if (message.files.length < 1) {
      this.log.info(`${message.id}: Failed attachment test`);
      return false;
    }

    let extensionTest = (file) => {
      let ext = file.displayExtension();

      // [@"pgp", @"gpg", @"asc"]
      // https://github.com/GPGTools/GPGMail/blob/master/Source/MimePart%2BGPGMail.m#L643
      if (ext === 'pgp' ||
          ext === 'gpg' ||
          ext === 'asc') {
        return true;
      }

      return false;
    };

    if (!message.files.some(extensionTest)) {
      Logger.info(`[PGP] ${message.id}: Failed extension test`);
      return false;
    }

    return true;
  }

  /**
   * Returns the state of the decrypter to @class{MessageLoaderHeader} to
   * display its status back to the user.
   *
   * @param {number} messageId - the message to retrieve state
   */
  getState(messageId) {
    return this._state.get(messageId);
  }

  /**
   * @private
   * Action Event: Decrypt message and reset the MessageBodyProcessor cached
   * message body for ONLY the message that corresponds to thedecrypted message
   */
  _decryptMessage(message) {
    this.log.info('Told to decrypt', message);
    this._decryptAndResetCache(message);
  }

  /**
   * @private
   * Action Event: Retry decryption after an error occurred
   *
   * This is because kbpgp would fail with Electron's buffer implementation
   */
  _retryMessage(message) {
    if (this._state.has(message.id) && this._state.get(message.id).decrypting) {
      this.log.error('Told to retry decrypt, but in the middle of decryption');
      return false;
    } else {
      this.log.info('Told to retry decrypt', message);
      this._state.delete(message.id);
      this._decryptAndResetCache(message);
    }
  }

  /**
   * @private
   * Set state for a particular instance of message decryption and tell
   * MessageLoaderHeader about the change in state, which the views will update
   * and re-render
   *
   * @callback MessageLoaderHeader._onPGPStoreChange
   */
  setState(messageId, state) {
    const prevState = this._state.get(messageId) || {};
    const nextState = Object.assign(prevState, state);
    this._state.set(messageId, nextState);
    this.trigger(messageId, nextState);
  }

  /**
   * @private
   * The main brains of this project. This retrieves the attachment and secret
   * key (someone help me find a (secure) way to store the secret key) in
   * parallel.
   *
   * Triggers a re-render through setState
   * @return {promise} request - resolves after successful decryption, rejects if the decryption fails at any stage
   */
  mainDecrypt(message) {
    if (this._state.has(message.id) && this._state.get(message.id).decrypting) {
      return Promise.reject(`Already decrypting ${message.id}`);
    }

    const request = new DecryptionRequest(this, message);

    //console.group(`[PGP] Message: ${message.id}`);
    return request.run();
    //.finally(() => {
    //  console.groupEnd();
    //});
  }

  // PGP HELPER INTERFACE

  _getKey() {
    var keyLocation = path.join(process.env.HOME, 'pgpkey');
    return fs.readFileAsync(keyLocation);
  }

  retrievePGPAttachment(message, notify) {
    this.log.info(`Attachments: %d`, message.files.length);

    // Check for GPGTools-like message, even though we aren't MIME parsed yet,
    // this still applies because the `octet-stream` attachments take
    // precedence
    // https://github.com/GPGTools/GPGMail/blob/master/Source/MimePart%2BGPGMail.m#L665
    var dataPart = null;
    var dataIndex = null;
    var lastContentType = '';
    if (message.files.length >= 1) {
      let {files} = message;

      files.forEach((file, i) => {
        if ((file.contentType === 'application/pgp-signature') || // EmailPGP-style encryption
            ((file.contentType === 'application/octet-stream' && !dataPart) ||
             (lastContentType === 'application/pgp-encrypted')) || // GPGTools-style encryption
            (file.contentType === 'application/pgp-encrypted' && !dataPart)) { // Fallback
          dataPart = file;
          dataIndex = i;
          lastContentType = file.contentType;
        }
      });
    }

    if (dataPart) {
      let path = FileDownloadStore.pathForFile(dataPart);
      this.log.info(`Using file[${dataIndex}] = %O`, dataPart);

      // async fs.exists was throwing because the first argument was true,
      // found fs.access as a suitable replacement
      return fs.accessAsync(path, fs.F_OK | fs.R_OK).then(() => {
        return fs.readFileAsync(path, 'utf8').then((text) => {
          this.log.info("Read attachment from disk");
          if (!text) {
            return Promise.reject(new FlowError("No text in attachment", true));
          }
          return text;
        });
      }).catch((err) => {
        notify('Waiting for encrypted message attachment to download...');
        this.log.info('Attachment file inaccessable, creating pending promise');

        return EmailPGPFileDownloadStoreWatcher.promiseForPendingFile(dataPart.id);
      });
    } else {
      return Promise.reject(new FlowError("No valid attachment"));
    }
  }

  // Retrieves the attachment and encrypted secret key for code divergence later
  getAttachmentAndKey(message, notify) {
    const keys = {};
    const gpg = KeyStore.getKeysGPG();

    for (let key of gpg) {
      if (!key) continue;
      keys[key.key] = `[${key.type}] ${key.fpr}`;
    }

    return Promise.all([
      this.retrievePGPAttachment(message, notify),
      smalltalk.dropdown('PGP Key', 'Which PGP key should be used for decryption of this message?', keys)
    ]).spread((text, pgpkey) => {
      if (!text) {
        return Promise.reject(new FlowError("No text in attachment", true));
      }
      if (!pgpkey) {
        return Promise.reject(new FlowError("No key in pgpkey variable", true));
      }
      return [text, pgpkey];
    });
  }

  _decryptAndResetCache(message) {
    let key = MessageBodyProcessor._key(message);

    return this.mainDecrypt(message).then(() => {
      if (this._state.has(message.id) && !this._state.get(message.id).lastError) {
        // Runs resetCache every run, and there can be many messages in a thread
        // that are encrypted. TODO: need a way to track currently processing
        // messages and run resetCache once, or only reprocess one message.
        //MessageBodyProcessor.resetCache();

        var messageIndex = null;
        MessageBodyProcessor._recentlyProcessedA.some(({key: _key, body}, i) => {
          if (key === _key) {
            messageIndex = i;
            return true;
          }

          return false;
        });

        if (messageIndex !== null) {
          MessageBodyProcessor._recentlyProcessedA.splice(messageIndex, 1);
          delete MessageBodyProcessor._recentlyProcessedD[key];
        }

        let processed = MessageBodyProcessor.process(message);
        MessageBodyProcessor._subscriptions.forEach(({message: _message, callback}) => {
          if (message.id === _message.id) {
            callback(processed);
          }
        });
      }
    }).catch((err) => {
      this.log.error(err);
    });
  }
}

export default new EmailPGPStore();