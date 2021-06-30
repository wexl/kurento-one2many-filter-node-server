/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs = require('fs');
var https = require('https');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:6008/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
    key: fs.readFileSync('keys/server.key'),
    cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = null;
var viewers = [];
var noPresenterMessage = 'No active presenter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function () {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server: server,
    path: '/one2many'
});

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

// rooms storage
// key: roomId, values: Presenter, Viewers
var rooms = {};

/*
 * Management of WebSocket messages
 */
wss.on('connection', function (ws) {

    var sessionId = nextUniqueId();
    console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function (error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function () {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function (_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
            case 'presenter':
                startPresenter(sessionId, ws, message.roomId, message.sdpOffer, function (error, sdpAnswer) {
                    if (error) {
                        return ws.send(JSON.stringify({
                            id: 'presenterResponse',
                            response: 'rejected',
                            message: error
                        }));
                    }
                    ws.send(JSON.stringify({
                        id: 'presenterResponse',
                        response: 'accepted',
                        sdpAnswer: sdpAnswer
                    }));
                });
                break;

            case 'viewer':
                startViewer(sessionId, ws, message.roomId, message.sdpOffer, function (error, sdpAnswer) {
                    if (error) {
                        return ws.send(JSON.stringify({
                            id: 'viewerResponse',
                            response: 'rejected',
                            message: error
                        }));
                    }

                    ws.send(JSON.stringify({
                        id: 'viewerResponse',
                        response: 'accepted',
                        sdpAnswer: sdpAnswer
                    }));
                });
                break;

            case 'stop':
                stop(sessionId, message.roomId);
                break;

            case 'onIceCandidate':
                onIceCandidate(sessionId, message.roomId, message.candidate);
                break;

            default:
                ws.send(JSON.stringify({
                    id: 'error',
                    message: 'Invalid message ' + message
                }));
                break;
        }
    });
});

/*
 * Definition of functions
 */

// check if the room exists
function getRoom(roomId, createIfnotExists = false, callback) {
    let room = rooms[roomId];
    if (!room && createIfnotExists) {
        rooms[roomId] = {};
        room = rooms[roomId];
    }
    if (room) return callback(null, room);
    return callback("Room doesn't exists");
}

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function (error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function startPresenter(sessionId, ws, roomId, sdpOffer, callback) {
    getRoom(roomId, true, (err, room) => {
        if (err) {
            stop(sessionId, roomId);
            return callback(err);
        }

        if (room.presenter) return callback("Already a presenter exists");

        room.presenter = {
            id: sessionId,
            pipeline: null,
            webRtcEndpoint: null
        }

        getKurentoClient(function (error, kurentoClient) {
            if (error) {
                stop(sessionId, roomId);
                return callback(error);
            }

            if (!room.presenter) {
                stop(sessionId, roomId);
                return callback(noPresenterMessage);
            }

            kurentoClient.create('MediaPipeline', function (error, pipeline) {
                if (error) {
                    stop(sessionId, roomId);
                    return callback(error);
                }

                if (!room.presenter) {
                    stop(sessionId, roomId);
                    return callback(noPresenterMessage);
                }

                room.presenter.pipeline = pipeline;
                createMediaElements(pipeline, (error, webRtcEndpoint, faceOverlayFilter) => {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }
                    room.presenter.webRtcEndpoint = webRtcEndpoint;
                    room.faceOverlayFilter = faceOverlayFilter;

                    if (room.candidatesQueue && room.candidatesQueue[sessionId]) {
                        while (room.candidatesQueue[sessionId].length) {
                            var candidate = room.candidatesQueue[sessionId].shift();
                            webRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    webRtcEndpoint.connect(faceOverlayFilter, (error) => {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        webRtcEndpoint.on('OnIceCandidate', function (event) {
                            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                            ws.send(JSON.stringify({
                                id: 'iceCandidate',
                                candidate: candidate
                            }));
                        });

                        webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
                            if (error) {
                                stop(sessionId, roomId);
                                return callback(error);
                            }

                            if (!room.presenter) {
                                stop(sessionId, roomId);
                                return callback(noPresenterMessage);
                            }

                            callback(null, sdpAnswer);
                        });

                        webRtcEndpoint.gatherCandidates(function (error) {
                            if (error) {
                                stop(sessionId, roomId);
                                return callback(error);
                            }
                        });
                    })
                })
            });
        });
    })
}

function startViewer(sessionId, ws, roomId, sdpOffer, callback) {
    getRoom(roomId, false, (err, room) => {
        if (err) {
            stop(sessionId, roomId);
            return callback(err);
        }

        if (!room.presenter) {
            stop(sessionId, roomId);
            return callback("No present for this room");
        }
        // clearCandidatesQueue(sessionId, roomId);

        room.presenter.pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
            if (error) {
                stop(sessionId, roomId);
                return callback(error);
            }
            if (!room.viewers) {
                room.viewers = {};
            }

            room.viewers[sessionId] = {
                "webRtcEndpoint": webRtcEndpoint,
                "ws": ws
            }

            if (!room.presenter) {
                stop(sessionId, roomId);
                return callback(noPresenterMessage);
            }

            if (room.candidatesQueue && room.candidatesQueue[sessionId]) {
                while (room.candidatesQueue[sessionId].length) {
                    var candidate = room.candidatesQueue[sessionId].shift();
                    webRtcEndpoint.addIceCandidate(candidate);
                }
            }

            webRtcEndpoint.on('OnIceCandidate', function (event) {
                var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                ws.send(JSON.stringify({
                    id: 'iceCandidate',
                    candidate: candidate
                }));
            });

            webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
                if (error) {
                    stop(sessionId, roomId);
                    return callback(error);
                }
                if (!room.presenter) {
                    stop(sessionId, roomId);
                    return callback(noPresenterMessage);
                }

                room.faceOverlayFilter.connect(webRtcEndpoint, function (error) {
                    if (error) {
                        stop(sessionId, roomId);
                        return callback(error);
                    }
                    if (!room.presenter) {
                        stop(sessionId, roomId);
                        return callback(noPresenterMessage);
                    }

                    callback(null, sdpAnswer);
                    webRtcEndpoint.gatherCandidates(function (error) {
                        if (error) {
                            stop(sessionId, roomId);
                            return callback(error);
                        }
                    });
                });
            });
        });
    })
}

function createMediaElements(pipeline, callback) {
    pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
        if (error) {
            return callback(error);
        }

        pipeline.create('FaceOverlayFilter', function (error, faceOverlayFilter) {
            if (error) {
                return callback(error);
            }

            // const appServerUrl = url.format(asUrl);
            const appServerUrl = "http://files.openvidu.io";
            faceOverlayFilter.setOverlayedImage(appServerUrl + '/img/mario-wings.png',
                -0.35, -1.2, 1.6, 1.6, function (error) {
                    if (error) {
                        return callback(error);
                    }

                    return callback(null, webRtcEndpoint, faceOverlayFilter);
                });
        });
    });
}

function connectMediaElements(webRtcEndpoint, faceOverlayFilter, callback) {
    webRtcEndpoint.connect(faceOverlayFilter, function (error) {
        if (error) {
            return callback(error);
        }

        faceOverlayFilter.connect(webRtcEndpoint, function (error) {
            if (error) {
                return callback(error);
            }

            return callback(null);
        });
    });
}

function clearCandidatesQueue(sessionId, roomId) {
    let room = rooms[roomId];
    if (room && room.candidatesQueue && room.candidatesQueue[sessionId]) {
        delete room.candidatesQueue[sessionId];
    }
}

function stop(sessionId, roomId) {
    let room = rooms[roomId];
    if (room) {
        if (room.presenter && room.presenter.id == sessionId) {
            for (var i in room.viewers) {
                var viewer = viewers[i];
                if (viewer.ws) {
                    viewer.ws.send(JSON.stringify({
                        id: 'stopCommunication'
                    }));
                }
            }
            room.presenter.pipeline.release();
            room.presenter = null;
            room.viewers = [];

        } else if (room.viewers && room.viewers[sessionId]) {
            room.viewers[sessionId].webRtcEndpoint.release();
            delete room.viewers[sessionId];
        }

        clearCandidatesQueue(sessionId, roomId);

        if (room.viewers.length < 1 && !room.presenter && kurentoClient !== null) {
            console.log('Closing kurento client');
            kurentoClient.close();
            kurentoClient = null;
        }
    }
}

function onIceCandidate(sessionId, roomId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);
    let room = rooms[roomId];
    if (!room) return;
    if (room.presenter && room.presenter.id === sessionId && room.presenter.webRtcEndpoint) {
        console.info('Sending presenter candidate');
        room.presenter.webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (room.viewers && room.viewers[sessionId] && room.viewers[sessionId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        room.viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!room.candidatesQueue) room.candidatesQueue = {};
        if (!room.candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
