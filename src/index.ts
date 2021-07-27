import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicValue,
  HAP,
  Logging,
  Service,
} from 'homebridge';

import netatmo from 'netatmo';

let hap: HAP;

export = (api: API) => {
  hap = api.hap;
  api.registerAccessory('homebridge-plugin-netatmo-wind-sensor', VirtualWindSensorPlugin);
};

enum VirtualWindSensorDeviceType {
  Switch,
  Leak
}

class VirtualWindSensorPlugin implements AccessoryPlugin {
  private readonly logging: Logging;
  private readonly virtualWindSensorService: Service;
  private readonly accessoryInformationService: Service;
  private readonly deviceType: VirtualWindSensorDeviceType;
  private readonly pollingIntervalInSec: number;
  private readonly slidingWindowSizeInMinutes: number;
  private readonly reauthenticationIntervalInMs: number;
  private readonly cooldownIntervalInMinutes: number;
  private netatmoApi: netatmo;
  private netatmoStationId?: string;
  private netatmoWindSensorId?: string;
  private windDetected: boolean;
  private readonly accessoryConfig: AccessoryConfig;
  private IsInCooldown: boolean;

  constructor(logging: Logging, accessoryConfig: AccessoryConfig) {
    this.logging = logging;
    this.accessoryConfig = accessoryConfig;
    this.netatmoStationId = undefined;
    this.netatmoWindSensorId = undefined;
    this.windDetected = false;
    this.deviceType = this.initializeDeviceType(accessoryConfig.deviceType);
    this.virtualWindSensorService = this.createAndConfigureService(this.deviceType);
    this.pollingIntervalInSec = accessoryConfig.pollingInterval;
    this.slidingWindowSizeInMinutes = accessoryConfig.slidingWindowSize;
    this.cooldownIntervalInMinutes = accessoryConfig.cooldownInterval;
    this.minimumSpeed = accessoryConfig.minimumSpeed;
    this.IsInCooldown = false;

    // Reauthenticate Netatmo API every 24 hours
    this.reauthenticationIntervalInMs = 24 * 60 * 60 * 1000;

    // Create a new Accessory Information Service
    this.accessoryInformationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Patrick Bär')
      .setCharacteristic(hap.Characteristic.Model, 'Virtual Device for Netatmo Wind Sensor');

    this.logging.info('Authenticating with the Netatmo API and configuring callbacks.');
    this.netatmoApi = this.authenticateAndConfigureNetatmoApi(accessoryConfig);

    this.logging.info('Looking for Netatmo Wind Sensor and setting up polling schedule.');
    this.netatmoApi.getStationsData();
  }

  createAndConfigureService(deviceType: VirtualWindSensorDeviceType): Service {
    let localVirtualWindSensorService: Service;

    if(deviceType === VirtualWindSensorDeviceType.Switch) {
      // Create a new Switch Sensor Service
      localVirtualWindSensorService = new hap.Service.Switch(this.accessoryConfig.name);

      // Create handler for wind detection
      localVirtualWindSensorService.getCharacteristic(hap.Characteristic.On)
        .onGet(this.handleSwitchOnGet.bind(this));
      localVirtualWindSensorService.getCharacteristic(hap.Characteristic.On)
        .onSet(this.handleSwitchOnSet.bind(this));

      this.logging.info('Exposing the Netatmo Wind Sensor as a Switch.');
    } else {
      // Create a new Leak Sensor Service
      localVirtualWindSensorService = new hap.Service.LeakSensor(this.accessoryConfig.name);

      // Create handler for leak detection
      localVirtualWindSensorService.getCharacteristic(hap.Characteristic.LeakDetected)
        .onGet(this.handleLeakDetectedGet.bind(this));

      this.logging.info('Exposing the Netatmo Wind Sensor as a Leak Sensor.');
    }

    return localVirtualWindSensorService;
  }

  initializeDeviceType(deviceTypeAsString: string): VirtualWindSensorDeviceType {
    if(!deviceTypeAsString || deviceTypeAsString === '' || deviceTypeAsString === 'Switch') {
      return VirtualWindSensorDeviceType.Switch;
    } else {
      return VirtualWindSensorDeviceType.Leak;
    }
  }

  getDevices(_error, devices): void {
    devices.forEach(device => {
      device.modules.forEach(module => {
        if(module.type === 'NAModule2') {
          this.logging.info(`Found first Netatmo Wind Sensor named "${module.module_name}". Using this Wind Sensor.`);
          this.netatmoStationId = device._id;
          this.netatmoWindSensorId = module._id;
        }
      });
    });
    if(this.netatmoWindSensorId !== undefined) {
      // Create recurring timer for Netatmo API reauthentication
      setInterval(this.forceReauthenticationOfNetatmoApi.bind(this), this.reauthenticationIntervalInMs);

      // Create recurring timer for Netatmo API polling
      const pollingIntervalInMs = this.pollingIntervalInSec * 1000;
      this.logging.debug(`Setting Netatmo API polling interval to ${pollingIntervalInMs}ms.`);
      setInterval(this.pollNetatmoApi.bind(this), pollingIntervalInMs);
      this.pollNetatmoApi();
    } else {
      this.logging.error('No Netatmo Wind Sensor found.');
    }
  }

  getMeasures(_error, measures): void {
    this.logging.debug(`Native output of measures: ${JSON.stringify(measures)}.`);

    if(this.IsInCooldown) {
      this.logging.debug('Cooldown detected. Skipping this wind detection cycle.');
    } else {
      this.windDetected = false;

      measures.forEach(measure => {
        measure.value.forEach(measuredValue => {
          if (measuredValue > this.minimumSpeed) {
            this.windDetected = true;
          }
        });
      });

      if(this.deviceType === VirtualWindSensorDeviceType.Switch) {
        this.handleSwitchOnSet(this.handleSwitchOnGet());
      } else {
        this.virtualWindSensorService.updateCharacteristic(hap.Characteristic.LeakDetected, this.handleLeakDetectedGet());
      }
    }
  }

  endCooldown(): void {
    this.IsInCooldown = false;
    this.logging.debug('Cooldown ended');
  }

  forceReauthenticationOfNetatmoApi(): void {
    this.logging.debug('Reauthenticating Netatmo API');
    this.shutdownNetatmoApi(this.netatmoApi);
    this.netatmoApi = this.authenticateAndConfigureNetatmoApi(this.accessoryConfig);
  }

  shutdownNetatmoApi(netatmoApi: netatmo): void {
    netatmoApi.removeAllListeners();
  }

  authenticateAndConfigureNetatmoApi(accessoryConfig: AccessoryConfig): netatmo {
    const auth = {
      'client_id': accessoryConfig.netatmoClientId,
      'client_secret': accessoryConfig.netatmoClientSecret,
      'username': accessoryConfig.netatmoUsername,
      'password': accessoryConfig.netatmoPassword,
    };

    const netatmoApi = new netatmo(auth);

    netatmoApi.on('error', this.handleNetatmoApiError.bind(this));
    netatmoApi.on('warning', this.handleNetatmoApiWarning.bind(this));
    netatmoApi.on('get-stationsdata', this.getDevices.bind(this));
    netatmoApi.on('get-measure', this.getMeasures.bind(this));

    return netatmoApi;
  }

  handleNetatmoApiError(errorMessage: string): void {
    this.logging.error(`Netatmo API error: ${errorMessage}.`);
  }

  handleNetatmoApiWarning(warningMessage: string): void {
    this.logging.warn(`Netatmo API warning: ${warningMessage}.`);
  }

  pollNetatmoApi(): void {
    if(this.IsInCooldown) {
      this.logging.debug('Cooldown detected. Skipping this wind detection cycle.');
    } else {
      this.logging.debug('Polling the Netatmo API.');
      const now = new Date().getTime();
      const slidingWindowSizeInMillis = this.slidingWindowSizeInMinutes * 60 * 1000;
      this.logging.debug(`Sliding window size in milliseconds: ${slidingWindowSizeInMillis}.`);
      const options = {
        device_id: this.netatmoStationId,
        module_id: this.netatmoWindSensorId,
        scale: '30min',
        type: ['wind'],
        date_begin: Math.floor(new Date(now - slidingWindowSizeInMillis).getTime()/1000),
        optimize: true,
        real_time: true,
      };
      this.logging.debug(`Native output of request options: ${JSON.stringify(options)}.`);
      this.netatmoApi.getMeasure(options);
    }
  }

  getServices(): Service[] {
    return [
      this.accessoryInformationService,
      this.virtualWindSensorService,
    ];
  }

  scheduleSwitchReset(): void {
    if(this.deviceType === VirtualWindSensorDeviceType.Switch) {
      setTimeout(() => this.handleSwitchOnSet(false), 500);
    }
  }

  handleLeakDetectedGet(): number {
    if(this.handleSwitchOnGet()) {
      return hap.Characteristic.LeakDetected.LEAK_DETECTED;
    } else {
      return hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    }
  }

  handleSwitchOnGet(): boolean {
    if(this.IsInCooldown) {
      this.logging.debug('Wind detected is false during cooldown.');
      return false;
    } else {
      if(this.windDetected) {
        this.logging.info('Wind detected!');

        if(this.cooldownIntervalInMinutes > 0) {
          const cooldownIntervalInMs = this.cooldownIntervalInMinutes * 60 * 1000;

          this.logging.debug(`Entering cooldown of ${cooldownIntervalInMs}ms.`);
          this.IsInCooldown = true;

          setTimeout(this.endCooldown.bind(this), cooldownIntervalInMs);
        }

        this.scheduleSwitchReset();
        return true;
      } else {
        this.logging.debug('No wind detected.');
        return false;
      }
    }
  }

  // value is type boolean for the switch service
  handleSwitchOnSet(value: CharacteristicValue): void {
    if(value) {
      this.logging.debug('Turn switch on.');
      this.scheduleSwitchReset();
    } else {
      this.logging.debug('Turn switch off.');
    }

    this.virtualWindSensorService.updateCharacteristic(hap.Characteristic.On, value);
  }
}
