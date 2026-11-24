'use strict';

const { Server } = require('socket.io');
const { getEnv } = require('../../config/env');

let io = null;

/**
 * Attaches Socket.IO to the HTTP server. Socket.IO falls back to HTTP long-polling automatically when the
 * hosting proxy blocks WebSockets. Live-quiz namespaces register their handlers on this instance.
 */
function attach(server) {
  const env = getEnv();
  io = new Server(server, {
    path: '/socket.io',
    serveClient: true,
    cors: { origin: env.APP_URL, credentials: true },
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: 64 * 1024,
  });
  return io;
}

const getIo = () => io;

module.exports = { attach, getIo };
