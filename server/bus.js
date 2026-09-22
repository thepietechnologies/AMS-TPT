'use strict';
/* ─── Real-time event bus (Server-Sent Events) ─────────────────────────────
 * §13 required flow:
 *   Event occurs → notification row created → delivered (in-app row written)
 *   → bus.publish(userId) → SSE → browser → bell updates instantly.
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per connected client

function publish(userId, payload) {
  bus.emit('user', { userId, payload });
}
function subscribe(listener) {
  bus.on('user', listener);
  return () => bus.off('user', listener);
}

module.exports = { publish, subscribe };
