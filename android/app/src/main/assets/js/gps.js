const EARTH_RADIUS_KM = 6371;

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

class GpsTracker {
  constructor() {
    this.watchId = null;
    this.shiftId = null;
    this.lastPoint = null;
    this.totalKm = 0;
    this.onUpdate = null;
    this.onError = null;
    this.minAccuracy = 80;
    this.minMoveM = 15;
    this.paused = false;
  }

  async start(shiftId, existingKm = 0) {
    if (!navigator.geolocation) {
      throw new Error('GPS недоступен на этом устройстве');
    }

    this.shiftId = shiftId;
    this.totalKm = existingKm;
    this.lastPoint = null;
    this.paused = false;

    const points = await TaxiDB.getGpsPoints(shiftId);
    if (points.length) {
      const last = points[points.length - 1];
      this.lastPoint = { lat: last.lat, lng: last.lng };
    }

    this._watch();
    return Promise.resolve();
  }

  _watch() {
    if (this.watchId !== null || this.paused || !this.shiftId) return;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handlePosition(pos),
      (err) => this.onError?.(err),
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000
      }
    );
  }

  _clearWatch() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  pause() {
    this.paused = true;
    this._clearWatch();
  }

  resume() {
    if (!this.shiftId) return;
    this.paused = false;
    this._watch();
  }

  async handlePosition(pos) {
    if (this.paused || !this.shiftId) return;

    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    if (accuracy > this.minAccuracy) return;

    const now = Date.now();
    const point = { lat, lng, timestamp: now };

    if (this.lastPoint) {
      const dist = haversine(this.lastPoint.lat, this.lastPoint.lng, lat, lng);
      if (dist * 1000 >= this.minMoveM) {
        this.totalKm += dist;
        this.lastPoint = { lat, lng };
        await TaxiDB.addGpsPoint(this.shiftId, lat, lng, now);
        await TaxiDB.updateShiftDistance(this.shiftId, this.totalKm);
        this.onUpdate?.(this.totalKm, point);
      }
    } else {
      this.lastPoint = { lat, lng };
      await TaxiDB.addGpsPoint(this.shiftId, lat, lng, now);
      this.onUpdate?.(this.totalKm, point);
    }
  }

  stop() {
    this._clearWatch();
    this.paused = false;
    this.shiftId = null;
    this.lastPoint = null;
  }

  getDistance() {
    return this.totalKm;
  }

  isTracking() {
    return this.watchId !== null;
  }
}

window.GpsTracker = GpsTracker;
