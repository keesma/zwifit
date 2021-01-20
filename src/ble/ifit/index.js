//
// Added support for Elliptical trainer
// 20200114 Tested with Proform Endurance E320
//
// Possible improvements
// - improve connection to MQTT broker
// - Consider to publish to MQTT label taking equipment id into account supporting multple devices, e.g. devices/ifitsync/eqid/speed
// 
const settings = require('../../settings');
const noble = require('noble');
const Constants = require('./_constants');
const request = require('./_request');
const events = require('../../lib/events');

const mqtt = require('mqtt')
const client = mqtt.connect('mqtt://mqttbroker', {clientId: 'ifitsync'})  // Connect to broker with own id

client.on('connect', () => {
	// Currently assuming that there is always an mqtt connection. This might need improvement.
	console.log('MQTT connected');
})

function mqttpublish(topic, value) {
        let t = 'devices/ifitsync/';
	t = t.concat(topic);
	client.publish(t, value, { retain:true });
	return 0
}


let sportsEquipment = undefined;
let rx = undefined;
let tx = undefined;
let equipmentInformation = undefined;
let readCurrentTimer = undefined;
let updateValues = undefined;
let current = {
	connected: false,
	mode: Constants.Mode.Idle
};
let disconnectedHook = undefined;
let zeroSpeedSend = false;
let previousMode = undefined;
let firstNoPulse = false;

exports.current = current;

function connect(callOnDisconnect) {
	disconnectedHook = callOnDisconnect;
	setTimeout(initializeBle, 2000);
	events.on('controlRequested', controlRequested);
}
exports.connect = connect;

function disconnect() {
	sportsEquipment.disconnect();
}
exports.disconnect = disconnect;

function peripheralDisconnected() {
	console.log('Disonnected :-(');
	mqttpublish('status', 'offline');

	current.connected = false;
	current.mode = Constants.Mode.Idle;
	
	if (readCurrentTimer) {
		clearInterval(readCurrentTimer);
	}
	sportsEquipment = undefined;
	readCurrentTimer = undefined;
	updateValues = undefined;
	rx = undefined;
	tx = undefined;
	
	if (disconnectedHook) {
		disconnectedHook();
	}
	
	noble.startScanning();
}

function controlRequested(message) {
	if (! readCurrentTimer) {
		return;
	}
	
	let speed = undefined;
	let distance = undefined;
	let calories = undefined;
	let pausedtime = undefined;
	let totaltime = undefined;
	if (message.kph) {
		if (equipmentInformation.Metric) {
			speed = safeParseFloat(message.kph);
		} else {
			speed = safeParseFloat(message.kph) * 0.621;
		}
	} else if (message.mph) {
		if (equipmentInformation.Metric) {
			speed = safeParseFloat(message.mph) / 0.621;
		} else {
			speed = safeParseFloat(message.mph);
		}
	}

	const updates = [];
	if (speed !== undefined) {
		if (speed <= equipmentInformation.MinKph) {
			updates.push({
				characteristic: Constants.Characteristic.Mode,
				value: Constants.Mode.Pause
			});
		} else {
			if (speed >= equipmentInformation.MaxKph) {
				speed = equipmentInformation.MaxKph;
			}
			updates.push({
				characteristic: Constants.Characteristic.Kph,
				value: speed
			});
		}
	}

	let newIncline = message.incline ? message.incline : message.zwiftIncline;
	if (newIncline !== undefined) {
		let incline = safeParseFloat(newIncline);
		if (incline <= equipmentInformation.MinIncline) {
			incline = equipmentInformation.MinIncline;
		} else if (incline >= equipmentInformation.MaxIncline) {
			incline = equipmentInformation.MaxIncline;
		}
		updates.push({
			characteristic: Constants.Characteristic.Incline,
			value: incline
		});
	}
	
	if (current.mode === Constants.Mode.Active || current.mode === Constants.Mode.Running) {
		updateValues = updates;
	}
}

function prettyPrintedBleCode() {
	return settings.bleCode.substring(2) + settings.bleCode.substring(0, 2);
}

function initializeBle() {
	
	//once a BLE device was found check if it is a iFit sport equiment
	noble.on('discover', function(peripheral) {
		if (! peripheral.advertisement.manufacturerData) {
			return;
		}
		if (peripheral.advertisement.manufacturerData
				&& peripheral.advertisement.manufacturerData.toString('hex')
						.toLowerCase().endsWith('dd' + settings.bleCode)) {
			noble.stopScanning();

			console.log('Found fitness equipment name with code '
					+ prettyPrintedBleCode()
					+ ' and name '
					+ settings.bleDeviceName);
			mqttpublish('ble-devicename', settings.bleDeviceName);
			mqttpublish('ble-code', prettyPrintedBleCode());
			sportsEquipment = peripheral;
			
			peripheral.on('disconnect', peripheralDisconnected);
	
			setTimeout(exploreSportsEquipment, 1000);
		}
	});
	
	//start scanning for sports equiments
	noble.on('stateChange', function(state) {
		if (state === 'poweredOn') {
			console.log('BLE: Powered On.');
			noble.startScanning();
		} else {
			console.log('BLE: Powered Off.');
			noble.stopScanning();
		}
	});

}

//connect to the sport equiment and store its characteristics
function exploreSportsEquipment() {
	
	sportsEquipment.connect(function(error) {
		if (error) {
			console.log('Could not connect to fitness equipment:', error);
			mqttpublish('status', 'offline');
			return;
		}
		
		request.initTxAndRx(sportsEquipment, (error, newTx, newRx) => {
			if (error) {
				console.log(error);
				mqttpublish('status', 'offline');
				sportsEquipment.disconnect();
				return;
			}
			tx = newTx;
			rx = newRx;
			loadEquipmentInformation();
		})

	});		
}

// initialize tx/rx communication
function loadEquipmentInformation() {
	
	request.getEquipmentInformation(tx, rx, function(data, error) {
		if (error) {
			console.log('Could not get equipment information:', error);
			mqttpublish('status', 'offline');
			sportsEquipment.disconnect();
		} else {
			equipmentInformation = data;
			loadSupportedCapabilities();
		}
	});
	
}

function loadSupportedCapabilities() {

	request.getSupportedCapabilities(equipmentInformation, tx, rx, function(supportedCapabilities, error) {
		if (error) {
			console.log('Could not get supported equipments:', error);
			mqttpublish('status', 'offline');
			sportsEquipment.disconnect();
		} else {
			equipmentInformation = {
					...equipmentInformation,
					...supportedCapabilities
				};
					mqttpublish('equipment-type', Constants.SportsEquipment.fromId(equipmentInformation.equipment));
//for (var i = 0; i < 10; i++) {
//    console.log(equipmentInformation.characteristics[i]);
//    //Do something
//}
					mqttpublish('mode', Constants.Mode.fromId(current.mode));
//			mqttpublish('capabilities/metric', equipmentInformation.Metric);
//			mqttpublish('capabilities', equipmentInformation);
			enable();
		}
	});

}

function enable() {

	request.enable(equipmentInformation, tx, rx, function(data, error) {
		if (error) {
			console.log('Failed to enable:', error);
			mqttpublish('status', 'offline');
			sportsEquipment.disconnect();
		} else {
			equipmentInformation = {
					...equipmentInformation,
					...data
				};
			readMaxAndMin();
		}
	}, settings.bleActivation);

}

function readMaxAndMin() {

	const reads = [
			Constants.Characteristic.MaxIncline,
			Constants.Characteristic.MinIncline,
			Constants.Characteristic.MaxKph,
			Constants.Characteristic.MinKph,
			Constants.Characteristic.MaxPulse,
			Constants.Characteristic.Metric
		];
	request.writeAndRead(equipmentInformation, undefined, reads, tx, rx, function(data, error) {
		if (error) {
			console.log('Failed to read max and mins:', error);
			mqttpublish('status', 'offline');
			sportsEquipment.disconnect();
		} else {
			equipmentInformation = {
					...equipmentInformation,
					...data
				};
			console.log('Connected :-)');
			mqttpublish('status', 'online');
			mqttpublish('capabilities/min-kmph', data.MinKph.toString());
			mqttpublish('capabilities/max-kmph', data.MaxKph.toString());
			current.connected = true;
			readCurrentTimer = setInterval(readCurrentValues, 500);
		}
	});

}

function readCurrentValues() {
// Received Endurance E320: 
//{
//  Pulse: { pulse: 0, average: 0, count: 0, source: 'No' },
//  Mode: 1,
//  CurrentKph: 0
//}
	
	const reads = [
			Constants.Characteristic.CurrentKph,
			Constants.Characteristic.CurrentIncline,
			Constants.Characteristic.Pulse,
			Constants.Characteristic.Mode,
			Constants.Characteristic.PausedTime,
//			Constants.Characteristic.CurrrentTime,
			Constants.Characteristic.TotalTime,
//			Constants.Characteristic.Metric,
			Constants.Characteristic.MaxKph,
			Constants.Characteristic.MinKph,
//			Constants.Characteristic.UpTime,
			Constants.Characteristic.Calories,
			Constants.Characteristic.CurrentDistance,
			Constants.Characteristic.CurrentCalories,
		];
	request.writeAndRead(equipmentInformation, updateValues, reads, tx, rx, function(data, error) {
		if (error) {
			if (error === 'disconnected') {
				clearInterval(readCurrentTimer);
			} else {
				console.log('Failed to read current values:', error);
			}
		} else {
				updateValues = undefined;
				current.mode = data.Mode;
				const changes = {};

				let speed;
				if (current.mode == Constants.Mode.Running || current.mode == Constants.Mode.Active) {
					mqttpublish('mode', Constants.Mode.fromId(current.mode));
					if (equipmentInformation.Metric === settings.metric) {
						speed = safeParseFloat(data.CurrentKph);
					} else if (equipmentInformation.Metric) {
						speed = safeParseFloat(data.CurrentKph) * 0.621;
					} else {
						speed = safeParseFloat(data.CurrentKph) / 0.621;
					}
					if (speed < 0.1) {
						speed = 0;
					} else {
						if (settings.speedOffset) {
							speed += safeParseFloat(settings.speedOffset);
						}
						if (settings.speedMultiplier) {
							speed *= safeParseFloat(settings.speedMultiplier);
						}
					}
					changes[settings.metric ? 'kph' : 'mph'] = speed;
					mqttpublish('speed', speed.toFixed(2));
					mqttpublish('speed/$unit', settings.metric ? 'km/h' : 'mi/h');
	
					distance = safeParseFloat(data.CurrentDistance);
					mqttpublish('distance', distance.toFixed(0));
					mqttpublish('distance/$unit', settings.metric ? 'm' : 'ft');
				
					calories = safeParseFloat(data.CurrentCalories);
					mqttpublish('calories', calories.toFixed(2));
					mqttpublish('calories/$unit', 'kcal');

					changes['incline'] = safeParseFloat(data.CurrentIncline);
//		for crosstrainer this does not work.
//					mqttpublish('incline', data.CurrentIncline);
					zeroSpeedSend = false;
					previousMode = current.mode;
				} else {
					if (!zeroSpeedSend) {
						mqttpublish('speed', "0.0");
						zeroSpeedSend = true;
						speed = 0;
						changes[settings.metric ? 'kph' : 'mph'] = speed;
					}
					if (previousMode != current.mode) {
						mqttpublish('mode', Constants.Mode.fromId(current.mode));
						previousMode = current.mode;
					}
	
				}
				if (current.mode != Constants.Mode.Idle) {
					if ((data.Pulse && (data.Pulse.source != Constants.PulseSource.fromId(Constants.PulseSource.No))) || firstNoPulse) {
						changes['hr'] = data.Pulse.pulse;
						mqttpublish('heart-rate/pulse', data.Pulse.pulse.toString());
						mqttpublish('heart-rate/source', data.Pulse.source);
						if  (data.Pulse && (data.Pulse.source == Constants.PulseSource.fromId(Constants.PulseSource.No)) && firstNoPulse) {
							firstNoPulse = false;;
						} else {
							firstNoPulse = true;
						}
					} else {
						firstNoPulse = true;
					}
				
					totaltime = safeParseFloat(data.TotalTime);
					mqttpublish('total-time', totaltime.toFixed(0));
					mqttpublish('total-time/$unit', 's');
					pausedtime = safeParseFloat(data.PausedTime);
					mqttpublish('paused-time', pausedtime.toFixed(0));
					mqttpublish('paused-time/$unit', 's');
				}
				events.fire('changeReceived', changes);
	
//			}
		}
	});
	
}

function safeParseFloat(val) {
	try {
		return parseFloat(val);
	}
	catch (err) {
		return 0;
	}
}
