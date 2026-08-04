const DB_NAME = 'TaxiShiftDB';
const DB_VERSION = 1;
const COMMISSION_PER_TRIP = 30;

const PAYMENT_LABELS = {
  cash: 'Наличные',
  card: 'Карта',
  app: 'Приложение'
};

const EXPENSE_LABELS = {
  fuel: 'Бензин',
  wash: 'Мойка',
  rent: 'Аренда авто',
  other: 'Прочее'
};

let db = null;

function openDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('shifts')) {
        const shifts = database.createObjectStore('shifts', { keyPath: 'id' });
        shifts.createIndex('startedAt', 'startedAt');
      }
      if (!database.objectStoreNames.contains('trips')) {
        const trips = database.createObjectStore('trips', { keyPath: 'id' });
        trips.createIndex('shiftId', 'shiftId');
        trips.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('expenses')) {
        const expenses = database.createObjectStore('expenses', { keyPath: 'id' });
        expenses.createIndex('shiftId', 'shiftId');
        expenses.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('gpsPoints')) {
        const gps = database.createObjectStore('gpsPoints', { keyPath: 'id', autoIncrement: true });
        gps.createIndex('shiftId', 'shiftId');
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return openDB().then((database) => database.transaction(store, mode).objectStore(store));
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function uuid() {
  return crypto.randomUUID();
}

async function getActiveShift() {
  const store = await tx('shifts');
  const all = await promisifyRequest(store.getAll());
  return all.find((s) => s.status === 'active') || null;
}

async function getShift(id) {
  const store = await tx('shifts');
  return promisifyRequest(store.get(id));
}

async function getAllShifts() {
  const store = await tx('shifts');
  const shifts = await promisifyRequest(store.getAll());
  return shifts.sort((a, b) => b.startedAt - a.startedAt);
}

async function startShift() {
  const active = await getActiveShift();
  if (active) throw new Error('Смена уже открыта');

  const shift = {
    id: uuid(),
    status: 'active',
    startedAt: Date.now(),
    endedAt: null,
    distanceKm: 0,
    note: ''
  };

  const store = await tx('shifts', 'readwrite');
  await promisifyRequest(store.add(shift));
  return shift;
}

async function endShift(shiftId) {
  const shift = await getShift(shiftId);
  if (!shift || shift.status !== 'active') throw new Error('Смена не найдена');

  shift.status = 'closed';
  shift.endedAt = Date.now();

  const store = await tx('shifts', 'readwrite');
  await promisifyRequest(store.put(shift));
  return shift;
}

async function updateShiftDistance(shiftId, distanceKm) {
  const shift = await getShift(shiftId);
  if (!shift) return;
  shift.distanceKm = distanceKm;
  const store = await tx('shifts', 'readwrite');
  await promisifyRequest(store.put(shift));
}

async function addTrip(shiftId, amount, paymentMethod) {
  const trip = {
    id: uuid(),
    shiftId,
    amount: Number(amount),
    paymentMethod,
    commission: COMMISSION_PER_TRIP,
    createdAt: Date.now()
  };
  const store = await tx('trips', 'readwrite');
  await promisifyRequest(store.add(trip));
  return trip;
}

async function deleteTrip(tripId) {
  const store = await tx('trips', 'readwrite');
  await promisifyRequest(store.delete(tripId));
}

async function getTripsByShift(shiftId) {
  const store = await tx('trips');
  const index = store.index('shiftId');
  const trips = await promisifyRequest(index.getAll(shiftId));
  return trips.sort((a, b) => b.createdAt - a.createdAt);
}

async function getTripsInRange(from, to) {
  const store = await tx('trips');
  const all = await promisifyRequest(store.getAll());
  return all.filter((t) => t.createdAt >= from && t.createdAt <= to);
}

async function addExpense(shiftId, category, amount, note = '') {
  const expense = {
    id: uuid(),
    shiftId,
    category,
    amount: Number(amount),
    note,
    createdAt: Date.now()
  };
  const store = await tx('expenses', 'readwrite');
  await promisifyRequest(store.add(expense));
  return expense;
}

async function deleteExpense(expenseId) {
  const store = await tx('expenses', 'readwrite');
  await promisifyRequest(store.delete(expenseId));
}

async function getExpensesByShift(shiftId) {
  const store = await tx('expenses');
  const index = store.index('shiftId');
  const items = await promisifyRequest(index.getAll(shiftId));
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

async function getExpensesInRange(from, to) {
  const store = await tx('expenses');
  const all = await promisifyRequest(store.getAll());
  return all.filter((e) => e.createdAt >= from && e.createdAt <= to);
}

async function addGpsPoint(shiftId, lat, lng, timestamp) {
  const store = await tx('gpsPoints', 'readwrite');
  await promisifyRequest(store.add({ shiftId, lat, lng, timestamp }));
}

async function getGpsPoints(shiftId) {
  const store = await tx('gpsPoints');
  const index = store.index('shiftId');
  return promisifyRequest(index.getAll(shiftId));
}

async function getShiftsInRange(from, to) {
  const all = await getAllShifts();
  return all.filter((s) => {
    const start = s.startedAt;
    const end = s.endedAt || Date.now();
    return start <= to && end >= from;
  });
}

async function getShiftStats(shiftId) {
  const [shift, trips, expenses] = await Promise.all([
    getShift(shiftId),
    getTripsByShift(shiftId),
    getExpensesByShift(shiftId)
  ]);
  return calcStats(shift, trips, expenses);
}

function calcStats(shiftsOrShift, trips, expenses) {
  const shifts = Array.isArray(shiftsOrShift) ? shiftsOrShift : [shiftsOrShift];
  const totalTrips = trips.length;
  const gross = trips.reduce((s, t) => s + t.amount, 0);
  const commission = trips.reduce((s, t) => s + (t.commission || COMMISSION_PER_TRIP), 0);
  const byPayment = { cash: 0, card: 0, app: 0 };
  trips.forEach((t) => {
    byPayment[t.paymentMethod] = (byPayment[t.paymentMethod] || 0) + t.amount;
  });
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const distanceKm = shifts.reduce((s, sh) => s + (sh?.distanceKm || 0), 0);
  const net = gross - commission - totalExpenses;
  const shiftMinutes = shifts.reduce((s, sh) => {
    if (!sh) return s;
    const end = sh.endedAt || Date.now();
    return s + (end - sh.startedAt) / 60000;
  }, 0);

  return {
    totalTrips,
    gross,
    commission,
    byPayment,
    totalExpenses,
    distanceKm,
    net,
    shiftMinutes,
    avgTrip: totalTrips ? gross / totalTrips : 0,
    incomePerKm: distanceKm ? gross / distanceKm : 0,
    netPerKm: distanceKm ? net / distanceKm : 0,
    netPerHour: shiftMinutes ? (net / shiftMinutes) * 60 : 0
  };
}

window.TaxiDB = {
  COMMISSION_PER_TRIP,
  PAYMENT_LABELS,
  EXPENSE_LABELS,
  openDB,
  getActiveShift,
  getShift,
  getAllShifts,
  startShift,
  endShift,
  updateShiftDistance,
  addTrip,
  deleteTrip,
  getTripsByShift,
  getTripsInRange,
  addExpense,
  deleteExpense,
  getExpensesByShift,
  getExpensesInRange,
  addGpsPoint,
  getGpsPoints,
  getShiftsInRange,
  getShiftStats,
  calcStats
};
