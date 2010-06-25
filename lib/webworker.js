// WebWorkers implementation.
//
// The master and workers communite over a UNIX domain socket at
// 
//      /tmp/node-webworker-<master PID>.sock
//
// This socket is used as a full-duplex channel for exchanging messages.
// Messages are objects encoded using the MessagePack format. Each message
// being exchanged is wrapped in an array envelope, the first element of
// which indicates the type of message being sent. For example take the
// following message (expresed in JSON)
//
//      [999, {'foo' : 'bar'}]
//
// This represents a message of type 999 with an object payload.
//
// o Message Types
//
//      MSGTYPE_NOOP        No-op. The payload of this message is discarded.
//
//      MSGTYPE_ERROR       An error has occurred. Used for bubbling up
//                          error events from the child process.
//
//      MSGTYPE_CLOSE       Graceful shut-down. Used to request that the
//                          child terminate gracefully.
//
//      MSGTYPE_USER        A user-specified message. All messages sent
//                          via the WebWorker API generate this type of
//                          message.

var assert = require('assert');
var child_process = require('child_process');
var events = require('events');
var fs = require('fs');
var net = require('net');
var netBinding = process.binding('net');
var path = require('path');
var sys = require('sys');
var wwutil = require('./webworker-util');

// Directory for our UNIX domain sockets
var SOCK_DIR_PATH = '/tmp/node-webworker-' + process.pid;

// The number of workers created so far
var numWorkersCreated = 0;

// A Web Worker implementation
//
// Each worker communicates with the master over a UNIX domain socket rooted
// in SOCK_DIR_PATH. Dedicated and shared workers both use an instance of
// this object to do their work. This object emits events which dedicated and
// shared workers listen to and convert to invocations of on*() handlers as
// specified in the W3C API.
var WorkerImpl = function(src) {
    events.EventEmitter.call(this);

    var self = this;

    // The timeout ID for killing off this worker if it is unresponsive to a
    // graceful shutdown request
    var killTimeoutID = undefined;
   
    // Process ID of child process running this worker
    //
    // This value persists even once the child process itself has
    // terminated; it is used as a key into datastructures managed by the
    // Master object.
    var pid = undefined;

    // Child process object
    //
    // This value is 'undefined' until the child process itself is spawned
    // and defined forever after.
    var cp = undefined;

    // The stream associated with this worker and wwutil.MsgStream that
    // wraps it.
    var stream = undefined;
    var msgStream = undefined;

    // Outbound message queue
    //
    // This queue is only written to when we don't yet have a stream to
    // talk to the worker. It contains [type, data, fd] tuples.
    var msgQueue = [];

    // The path to our socket
    var sockPath = path.join(SOCK_DIR_PATH, numWorkersCreated++);

    // Server instance for our communication socket with the child process
    //
    // Doesn't begin listening until start() is called.
    var srv = net.createServer(function(s) {
        assert.equal(stream, undefined);
        assert.equal(msgStream, undefined);

        stream = s;
        msgStream = new wwutil.MsgStream(s);

        // Process any messages waiting to be sent
        msgQueue.forEach(function(m) {
            var fd = m.pop();
            msgStream.send(m, fd);
        });

        msgQueue = [];

        // Process incoming messages with handleMessage()
        msgStream.addListener('msg', handleMessage);
    });

    // The primary message handling function for the worker.
    //
    // This is only invoked after handshaking has occurred.
    var handleMessage = function(msg, fd) {
        if (!wwutil.isValidMessage(msg)) {
            wwutil.debug(1, 'Received invalid message: ' + sys.inspect(msg));
            return;
        }

        wwutil.debug(3,
            'Received message type=' + msg[0] + ', data=' + sys.inspect(msg[1])
        );

        switch (msg[0]) {
        case wwutil.MSGTYPE_NOOP:
            break;

        case wwutil.MSGTYPE_ERROR:
            process.nextTick(function() {
                self.emit('error', msg[1]);
            });
            break;

        case wwutil.MSGTYPE_USER:
            process.nextTick(function() {
                e = { data : msg[1] };
                if (fd) {
                    e.fd = fd;
                }

                self.emit('message', e);
            });
            break;

        default:
            wwutil.debug(1,
                'Received unexpected message: ' + sys.inspect(msg)
            );
            break;
        }
    };

    // Do the heavy lifting of posting a message
    var postMessageImpl = function(msgType, msg, fd) {
        assert.ok(msgQueue.length == 0 || !msgStream);

        var m = [msgType, msg];

        if (msgStream) {
            msgStream.send(m, fd);
        } else {
            m.push(fd);
            msgQueue.push(m);
        }
    };

    // Begin worker execution
    //
    // First fires up the UNIX socket server, then spawns the child process
    // and away we go.
    self.start = function() {
        srv.addListener('listening', function() {
            cp = child_process.spawn(
                process.argv[0],
                [
                    path.join(__dirname, 'webworker-child.js'),
                    sockPath,
                    'file://' + src
                ],
                undefined,
                [0, 1, 2]
            );

            // Save off the PID of the child process, as this value gets
            // undefined once the process exits.
            pid = cp.pid;

            wwutil.debug(1,
                'Spawned process ' + pid + ' for worker \'' + src + '\''
            );

            cp.addListener('exit', function(code, signal) {
                wwutil.debug(1,
                    'Process ' + pid + ' for worker \'' + src + 
                        '\' exited with status ' + code +', signal ' + signal
                );

                // If we have an outstanding timeout for killing off this process,
                // abort it.
                if (killTimeoutID) {
                    clearTimeout(killTimeoutID);
                }

                if (stream) {
                    stream.destroy();
                } else {
                    wwutil.debug(1,
                        'Process ' + pid + ' exited without completing handshaking'
                    );
                }

                srv.close();

                process.nextTick(function() {
                    self.emit('exit', code, signal);
                });
            });
        });

        srv.listen(sockPath);
    };

    // Post a message to the worker
    self.postMessage = function(msg, fd) {
        postMessageImpl(wwutil.MSGTYPE_USER, msg, fd);
    };

    // Terminate the worker
    //
    // Takes a timeout value for forcibly killing off the worker if it does
    // not shut down gracefully on its own. By default, this timeout is
    // 5 seconds. A value of 0 indicates infinite timeout.
    self.terminate = function(timeout) {
        assert.notEqual(pid, undefined);
        assert.ok(cp.pid == pid || !cp.pid);

        timeout = (timeout === undefined) ?  5000 : timeout;

        // The child process is already shut down; no-op
        if (!cp.pid) {
            return;
        }

        // The termination process has already been initiated for this
        // process
        if (killTimeoutID) {
            return;
        }

        // Request graceful shutdown of the child process
        postMessageImpl(wwutil.MSGTYPE_CLOSE);

        // Optionally set a timer to kill off the child process forcefully if
        // it has not shut down by itself.
        if (timeout > 0) {
            killTimeoutID = setTimeout(function() {
                // Clear our ID since we're now running
                killTimeoutID = undefined;

                if (!cp.pid) {
                    return;
                }

                wwutil.debug(1,
                    'Forcibily terminating worker process ' + pid + 
                        ' with SIGTERM'
                );

                cp.kill('SIGTERM');
            }, timeout);
        }
    };
};
sys.inherits(WorkerImpl, events.EventEmitter);

var Worker = function(src) {
    var self = this;

    // The worker implementation
    var impl = new WorkerImpl(src);

    // Wire up events from the worker implementation to on*() hooks as
    // specified by the W3C API
    impl.addListener('error', function(e) {
        if (self.onerror) {
            self.onerror(e);
        }
    });
    impl.addListener('message', function(e) {
        if (self.onmessage) {
            self.onmessage(e);
        }
    });
    impl.addListener('exit', function(code, signal) {
        if (self.onexit) {
            self.onexit(code, signal);
        }
    });

    // External API

    self.postMessage = function(msg, fd) {
        return impl.postMessage(msg, fd);
    };

    self.terminate = function(timeout) {
        return impl.terminate(timeout);
    };

    impl.start();
};
exports.Worker = Worker;

// Perform any one-time initialization
fs.mkdirSync(SOCK_DIR_PATH, 0700);
