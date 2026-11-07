// Entry for test/platform/phone-shims.test.mjs: exposes the phone's replacements for Node modules so the test can compare them with Node's own.
import * as buffer from '../../mobile/server/src/shims/buffer';
import * as crypto from '../../mobile/server/src/shims/crypto';
import * as path from '../../mobile/server/src/shims/path';
import * as zlib from '../../mobile/server/src/shims/zlib';
import * as events from '../../mobile/server/src/shims/events';
import * as util from '../../mobile/server/src/shims/util';
import * as url from '../../mobile/server/src/shims/url';
import * as os from '../../mobile/server/src/shims/os';
(globalThis as any).__shims = { buffer, crypto, path, zlib, events, util, url, os };
