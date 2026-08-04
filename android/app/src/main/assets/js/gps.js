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
  }

  async start(shiftId, existingKm = 0) {
    if (!navigator.geolocation) {
      throw new Error('GPS недоступен на этом устройстве');
    }

    this.shiftId = shiftId;
    this.totalKm = existingKm;
    this.lastPoint = null;

    const points = await TaxiDB.getGpsPoints(shiftId);
    if (points.length) {
      const last = points[points.length - 1];
      this.lastPoint = { lat: last.lat, lng: last.lng };
    }

    return new Promise((resolve, reject) => {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.handlePosition(pos),
        (err) => {
          this.onError?.(err);
          if (!this.lastPoint) reject(err);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 20000
        }
      );
      resolve();
    });
  }

  async handlePosition(pos) {
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
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.shiftId = null;
    this.lastPoint = null;
  }

  getDistance() {
    return this.totalKm;
  }
}

window.GpsTracker = GpsTracker;
