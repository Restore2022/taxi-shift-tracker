function formatMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0
  }).format(n || 0);
}

function formatPerHour(n) {
  if (n === null || n === undefined) return '—';
  return formatMoney(n);
}

function formatKm(n) {
  return `${(n || 0).toFixed(1)} км`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} мин`;
  return `${h} ч ${m} мин`;
}

function formatDate(ts) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(ts);
}

function formatTime(ts) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(ts);
}

function formatDateTime(ts) {
  return `${formatDate(ts)} ${formatTime(ts)}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}

function startOfWeek(d) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? 6 : day - 1;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function endOfWeek(d) {
  const start = startOfWeek(d);
  const x = new Date(start);
  x.setDate(x.getDate() + 6);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}

function startOfMonth(d) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function endOfMonth(d) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + 1, 0);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}

function getPeriodRange(preset, customFrom, customTo) {
  const now = Date.now();
  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now), label: 'Сегодня' };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y), label: 'Вчера' };
    }
    case 'week':
      return {
        from: startOfWeek(now),
        to: endOfWeek(now),
        label: 'Эта неделя'
      };
    case 'month':
      return {
        from: startOfMonth(now),
        to: endOfMonth(now),
        label: 'Этот месяц'
      };
    case 'custom':
      return {
        from: startOfDay(new Date(customFrom)),
        to: endOfDay(new Date(customTo)),
        label: `${formatDate(new Date(customFrom))} — ${formatDate(new Date(customTo))}`
      };
    default:
      return { from: startOfDay(now), to: endOfDay(now), label: 'Сегодня' };
  }
}

async function buildPeriodReport(from, to) {
  const [trips, expenses, shifts] = await Promise.all([
    TaxiDB.getTripsInRange(from, to),
    TaxiDB.getExpensesInRange(from, to),
    TaxiDB.getShiftsInRange(from, to)
  ]);

  const stats = TaxiDB.calcStats(shifts, trips, expenses);

  const expensesByCategory = {};
  expenses.forEach((e) => {
    expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount;
  });

  const dailyMap = {};
  trips.forEach((t) => {
    const day = startOfDay(t.createdAt);
    if (!dailyMap[day]) dailyMap[day] = { gross: 0, trips: 0, commission: 0 };
    dailyMap[day].gross += t.amount;
    dailyMap[day].trips += 1;
    dailyMap[day].commission += t.commission || TaxiDB.COMMISSION_PER_TRIP;
  });

  expenses.forEach((e) => {
    const day = startOfDay(e.createdAt);
    if (!dailyMap[day]) dailyMap[day] = { gross: 0, trips: 0, commission: 0, expenses: 0 };
    dailyMap[day].expenses = (dailyMap[day].expenses || 0) + e.amount;
  });

  const daily = Object.entries(dailyMap)
    .map(([day, data]) => ({
      day: Number(day),
      ...data,
      net: data.gross - data.commission - (data.expenses || 0)
    }))
    .sort((a, b) => a.day - b.day);

  const shiftReports = await Promise.all(
    shifts.map(async (s) => {
      const sTrips = trips.filter((t) => t.shiftId === s.id);
      const sExpenses = expenses.filter((e) => e.shiftId === s.id);
      return {
        shift: s,
        stats: TaxiDB.calcStats([s], sTrips, sExpenses)
      };
    })
  );

  return { stats, expensesByCategory, daily, shiftReports, trips, expenses };
}

window.TaxiReports = {
  formatMoney,
  formatPerHour,
  formatKm,
  formatDuration,
  formatDate,
  formatTime,
  formatDateTime,
  getPeriodRange,
  buildPeriodReport
};
