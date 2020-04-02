const { describe, it } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const { objectStoreForProtocol, defaultObjectStore, S3ObjectStore } = require('../../app/util/object-store');

describe('util/object-store', function () {
  describe('objectStoreForProtocol', function () {
    it('returns null when no protocol is supplied', function () {
      expect(objectStoreForProtocol()).to.be.null;
    });

    it('returns null when an unrecognized protocol is supplied', function () {
      expect(objectStoreForProtocol('azure')).to.be.null;
    });

    it('returns an S3ObjectStore when "s3" is supplied as the protocol', function () {
      expect(objectStoreForProtocol('s3')).to.be.instanceof(S3ObjectStore);
    });

    it('is case insensitive', function () {
      expect(objectStoreForProtocol('S3')).to.be.instanceof(S3ObjectStore);
    });

    it('ignores trailing colons on the protocol', function () {
      expect(objectStoreForProtocol('s3:')).to.be.instanceof(S3ObjectStore);
    });
  });

  describe('defaultObjectStore', function () {
    it('returns an S3 object store', function () {
      expect(defaultObjectStore()).to.be.instanceof(S3ObjectStore);
    });
  });

  describe('S3ObjectStore', function () {
    describe('#getObject', function () {
      it('parses valid S3 URL strings and passes their bucket and key to s3.getObject', function () {
        const store = new S3ObjectStore();
        const s3 = sinon.mock(store.s3);
        s3.expects('getObject').once().withArgs({ Bucket: 'example-bucket', Key: 'example/path.txt' });
        store.getObject('s3://example-bucket/example/path.txt');
      });

      it('raises exceptions for invalid S3 URL strings', function () {
        const store = new S3ObjectStore();
        expect(() => store.getObject('s://example-bucket/example/path.txt')).to.throw(TypeError);
      });

      it('passes options objects directly to s3.getObject', function () {
        const store = new S3ObjectStore();
        const options = { Bucket: 'example-bucket', Key: 'example/path.txt' };
        const s3 = sinon.mock(store.s3);
        s3.expects('getObject').once().withArgs(options);
        store.getObject(options);
      });
    });

    describe('#getUrlString', function () {
      it('returns a string corresponding to the bucket and key location using the s3:// protocol', function () {
        expect(new S3ObjectStore().getUrlString('mybucket', 'my/key/path')).to.equal('s3://mybucket/my/key/path');
      });
    });
  });
});