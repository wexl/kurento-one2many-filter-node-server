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

var ws = new WebSocket('wss://' + location.host + '/one2many');
var video;
var webRtcPeer, pc;
var roomIdInput, statsContainer, enableStats;

window.onload = function () {
	// console = new Console();
	video = document.getElementById('video');
	roomIdInput = document.getElementById("roomId");
	statsContainer = document.getElementById("stats-container");
	enableStats = document.getElementById("enable-stats");

	presenterBtn = document.getElementById('call');
	viewerBtn = document.getElementById('viewer');
	terminateBtn = document.getElementById('terminate');

	presenterBtn.addEventListener('click', function () { presenter(); });
	viewerBtn.addEventListener('click', function () { viewer(); });
	terminateBtn.addEventListener('click', function () { stop(); });

	enableStats.addEventListener('change', () => {
		if (!enableStats.checked) statsContainer.innerHTML = "";
	})
}

window.onbeforeunload = function () {
	ws.close();
}

ws.onmessage = function (message) {
	var parsedMessage = JSON.parse(message.data);
	console.info('Received message: ' + message.data);

	switch (parsedMessage.id) {
		case 'presenterResponse':
			presenterResponse(parsedMessage);
			break;
		case 'viewerResponse':
			viewerResponse(parsedMessage);
			break;
		case 'stopCommunication':
			dispose();
			break;
		case 'iceCandidate':
			webRtcPeer.addIceCandidate(parsedMessage.candidate)
			break;
		default:
			console.error('Unrecognized message', parsedMessage);
	}
}

function presenterResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknow error';
		console.warn('Call not accepted for the following reason: ' + errorMsg);
		dispose();
	} else {
		webRtcPeer.processAnswer(message.sdpAnswer);
	}
}

function viewerResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknow error';
		console.warn('Call not accepted for the following reason: ' + errorMsg);
		dispose();
	} else {
		webRtcPeer.processAnswer(message.sdpAnswer);
	}
}

function presenter() {
	if (!webRtcPeer) {
		showSpinner(video);

		var options = {
			localVideo: video,
			onicecandidate: onIceCandidate
		}

		webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function (error) {
			if (error) return onError(error);
			webRtcPeer.generateOffer(onOfferPresenter);
		});
		pc = webRtcPeer.peerConnection;
		setInterval(handlePresenterStats, 1000);
		presenterBtn.disabled = true;
		viewerBtn.disabled = true;
		terminateBtn.disabled = false;
	}
}

function onOfferPresenter(error, offerSdp) {
	if (error) return onError(error);

	var message = {
		id: 'presenter',
		sdpOffer: offerSdp,
		roomId: roomIdInput.value
	};
	sendMessage(message);
}

function viewer() {
	if (!webRtcPeer) {
		showSpinner(video);

		var options = {
			remoteVideo: video,
			onicecandidate: onIceCandidate
		}

		webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function (error) {
			if (error) return onError(error);
			webRtcPeer.generateOffer(onOfferViewer);
		});
		pc = webRtcPeer.peerConnection;

		setInterval(handleViewerStats, 1000);
		presenterBtn.disabled = true;
		viewerBtn.disabled = true;
		terminateBtn.disabled = false;
	}
}

function onOfferViewer(error, offerSdp) {
	if (error) return onError(error)

	var message = {
		id: 'viewer',
		sdpOffer: offerSdp,
		roomId: roomIdInput.value,
	}
	sendMessage(message);
}

function onIceCandidate(candidate) {
	console.log('Local candidate' + JSON.stringify(candidate));

	var message = {
		id: 'onIceCandidate',
		candidate: candidate,
		roomId: roomIdInput.value
	}
	sendMessage(message);
}

function stop() {
	if (webRtcPeer) {
		var message = {
			id: 'stop',
			roomId: roomIdInput.value,
		}
		sendMessage(message);
		dispose();

		presenterBtn.disabled = false;
		viewerBtn.disabled = false;
		terminateBtn.disabled = true;
	}
}

function dispose() {
	if (webRtcPeer) {
		webRtcPeer.dispose();
		webRtcPeer = null;
	}
	hideSpinner(video);
}

function sendMessage(message) {
	var jsonMessage = JSON.stringify(message);
	console.log('Senging message: ' + jsonMessage);
	ws.send(jsonMessage);
}

function showSpinner() {
	for (var i = 0; i < arguments.length; i++) {
		arguments[i].poster = './img/transparent-1px.png';
		arguments[i].style.background = 'center transparent url("./img/spinner.gif") no-repeat';
	}
}

function hideSpinner() {
	for (var i = 0; i < arguments.length; i++) {
		arguments[i].src = '';
		arguments[i].poster = './img/webrtc.png';
		arguments[i].style.background = '';
	}
}

function handlePresenterStats() {
	if (!enableStats.checked) return;
	pc.getStats().then(stats => {
		if (!stats) return;
		let fps, encoder, width, height;
		let statsOutput = "<h2>Detailed Analytics</h2>";
		stats.forEach(report => {
			if (report.type === "outbound-rtp" && report.kind === "video") {
				Object.keys(report).forEach(statName => {
					switch (statName) {
						case "framesPerSecond":
							fps = report[statName];
							statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
							break;
						case "encoderImplementation":
							encoder = report[statName];
							statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
							break;
						case "frameWidth":
							width = report[statName];
							break;
						case "frameHeight":
							height = report[statName];
							break;
						default:
							break;
					}
				});
			}
		});
		if(width && height){
			statsOutput += `<strong>Resolution:</strong> ${width}x${height}<br>\n`;
		}
		statsContainer.innerHTML = statsOutput;
	})
}

function handleViewerStats() {
	if (!enableStats.checked) return;
	pc.getStats().then(stats => {
		if (!stats) return;
		let fps, encoder, width, height;
		let statsOutput = "<h2>Detailed Analytics</h2>";
		stats.forEach(report => {
			if (report.type === "inbound-rtp" && report.kind === "video") {
				console.log("[viewer report]", report)
				Object.keys(report).forEach(statName => {
					switch (statName) {
						case "framesPerSecond":
							fps = report[statName];
							statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
							break;
						case "decoderImplementation":
							encoder = report[statName];
							statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
							break;
						case "frameWidth":
							width = report[statName];
							break;
						case "frameHeight":
							height = report[statName];
							break;
						default:
							break;
					}
				});
			}
		});
		if(width && height){
			statsOutput += `<strong>Resolution:</strong> ${width}x${height}<br>\n`;
		}
		statsContainer.innerHTML = statsOutput;
	})
}
/**
 * Lightbox utility (to display media pipeline image in a modal dialog)
 */
$(document).delegate('*[data-toggle="lightbox"]', 'click', function (event) {
	event.preventDefault();
	$(this).ekkoLightbox();
});
