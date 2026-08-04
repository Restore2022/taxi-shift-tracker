const tracker = new GpsTracker();
let activeShift = null;
let liveTimer = null;
let currentPeriod = 'today';

function $(sel) {
  return document.querySelector(sel);
}

function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });
  if (name === 'reports') renderReport();
  if (name === 'history') renderHistory();
}

async function init() {
  await TaxiDB.openDB();
  bindEvents();
  await refreshShiftUI();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  $('#btn-start-shift').addEventListener('click', startShiftHandler);
  $('#btn-end-shift').addEventListener('click', endShiftHandler);
  $('#trip-form').addEventListener('submit', addTripHandler);
  $('#expense-form').addEventListener('submit', addExpenseHandler);

  document.querySelectorAll('.period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      $('#custom-period').classList.toggle('hidden', currentPeriod !== 'custom');
      if (currentPeriod !== 'custom') renderReport();
    });
  });

  $('#btn-apply-period').addEventListener('click', renderReport);

  tracker.onUpdate = (km) => {
    $('#live-km').textContent = TaxiReports.formatKm(km);
    setGpsStatus('active', 'GPS: отслеживание активно');
  };

  tracker.onError = (err) => {
    const msgs = {
      1: 'GPS: нет разрешения на геолокацию',
      2: 'GPS: позиция недоступна',
      3: 'GPS: таймаут'
    };
    setGpsStatus('error', msgs[err.code] || 'GPS: ошибка');
  };
}

function setGpsStatus(type, text) {
  const el = $('#gps-status');
  el.textContent = text;
  el.className = `gps-status ${type}`;
}

async function startShiftHandler() {
  try {
    const perm = await requestGeoPermission();
    if (!perm) {
      showToast('Нужен доступ к геолокации для пробега');
      return;
    }

    activeShift = await TaxiDB.startShift();
    await tracker.start(activeShift.id, 0);
    setGpsStatus('active', 'GPS: поиск сигнала...');
    showToast('Смена открыта');
    await refreshShiftUI();
  } catch (e) {
    showToast(e.message || 'Ошибка открытия смены');
  }
}

async function requestGeoPermission() {
  if (!navigator.geolocation) return false;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      () => resolve(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function endShiftHandler() {
  if (!activeShift) return;
  if (!confirm('Закрыть смену?')) return;

  tracker.stop();
  await TaxiDB.endShift(activeShift.id);
  clearInterval(liveTimer);
  liveTimer = null;
  activeShift = null;
  showToast('Смена закрыта');
  await refreshShiftUI();
}

async function addTripHandler(e) {
  e.preventDefault();
  if (!activeShift) return;

  const amount = $('#trip-amount').value;
  const payment = document.querySelector('input[name="payment"]:checked').value;

  await TaxiDB.addTrip(activeShift.id, amount, payment);
  $('#trip-amount').value = '';
  $('#trip-amount').focus();
  showToast(`+${amount} ₽ добавлено`);
  await refreshShiftLists();
  await updateLiveStats();
}

async function addExpenseHandler(e) {
  e.preventDefault();
  if (!activeShift) return;

  const category = $('#expense-category').value;
  const amount = $('#expense-amount').value;
  const note = $('#expense-note').value;

  await TaxiDB.addExpense(activeShift.id, category, amount, note);
  $('#expense-amount').value = '';
  $('#expense-note').value = '';
  showToast('Расход добавлен');
  await refreshShiftLists();
  await updateLiveStats();
}

async function refreshShiftUI() {
  activeShift = await TaxiDB.getActiveShift();
  const badge = $('#shift-badge');

  if (activeShift) {
    $('#no-shift').classList.add('hidden');
    $('#active-shift').classList.remove('hidden');
    badge.classList.remove('hidden');

    if (!tracker.watchId) {
      try {
        await tracker.start(activeShift.id, activeShift.distanceKm || 0);
        setGpsStatus('active', 'GPS: отслеживание активно');
      } catch {
        setGpsStatus('error', 'GPS: не удалось возобновить');
      }
    }

    startLiveTimer();
    await refreshShiftLists();
    await updateLiveStats();
  } else {
    $('#no-shift').classList.remove('hidden');
    $('#active-shift').classList.add('hidden');
    badge.classList.add('hidden');
    tracker.stop();
    clearInterval(liveTimer);
  }
}

function startLiveTimer() {
  if (liveTimer) return;
  liveTimer = setInterval(updateLiveTime, 30000);
  updateLiveTime();
}

function updateLiveTime() {
  if (!activeShift) return;
  const mins = (Date.now() - activeShift.startedAt) / 60000;
  $('#live-time').textContent = TaxiReports.formatDuration(mins);
}

async function updateLiveStats() {
  if (!activeShift) return;
  const stats = await TaxiDB.getShiftStats(activeShift.id);
  $('#live-km').textContent = TaxiReports.formatKm(activeShift.distanceKm || tracker.getDistance());
  $('#live-gross').textContent = TaxiReports.formatMoney(stats.gross);
  $('#live-net').textContent = TaxiReports.formatMoney(stats.net);
  $('#trip-count').textContent = stats.totalTrips;
}

async function refreshShiftLists() {
  if (!activeShift) return;

  const [trips, expenses] = await Promise.all([
    TaxiDB.getTripsByShift(activeShift.id),
    TaxiDB.getExpensesByShift(activeShift.id)
  ]);

  const tripList = $('#trip-list');
  if (!trips.length) {
    tripList.innerHTML = '<li class="empty-state">Пока нет поездок</li>';
  } else {
    tripList.innerHTML = trips
      .map(
        (t) => `
      <li class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiReports.formatMoney(t.amount)}</div>
          <div class="list-item-sub">${TaxiDB.PAYMENT_LABELS[t.paymentMethod]} · −${t.commission} ₽ комиссия · ${TaxiReports.formatTime(t.createdAt)}</div>
        </div>
        <button class="btn-icon" data-delete-trip="${t.id}" aria-label="Удалить">×</button>
      </li>`
      )
      .join('');
  }

  const expenseList = $('#expense-list');
  if (!expenses.length) {
    expenseList.innerHTML = '<li class="empty-state">Нет расходов</li>';
  } else {
    expenseList.innerHTML = expenses
      .map(
        (e) => `
      <li class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiDB.EXPENSE_LABELS[e.category]}</div>
          <div class="list-item-sub">${e.note || '—'} · ${TaxiReports.formatTime(e.createdAt)}</div>
        </div>
        <span class="list-item-amount negative">−${e.amount} ₽</span>
        <button class="btn-icon" data-delete-expense="${e.id}" aria-label="Удалить">×</button>
      </li>`
      )
      .join('');
  }

  tripList.querySelectorAll('[data-delete-trip]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await TaxiDB.deleteTrip(btn.dataset.deleteTrip);
      await refreshShiftLists();
      await updateLiveStats();
    });
  });

  expenseList.querySelectorAll('[data-delete-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await TaxiDB.deleteExpense(btn.dataset.deleteExpense);
      await refreshShiftLists();
      await updateLiveStats();
    });
  });
}

async function renderReport() {
  const customFrom = $('#period-from').value;
  const customTo = $('#period-to').value;
  const range = TaxiReports.getPeriodRange(currentPeriod, customFrom, customTo);
  const report = await TaxiReports.buildPeriodReport(range.from, range.to);
  const { stats, expensesByCategory, daily, shiftReports } = report;

  const maxDaily = Math.max(...daily.map((d) => d.gross), 1);

  let expensesHtml = Object.entries(expensesByCategory)
    .map(
      ([cat, sum]) =>
        `<div class="report-item"><div class="report-item-label">${TaxiDB.EXPENSE_LABELS[cat] || cat}</div><div class="report-item-value red">${TaxiReports.formatMoney(sum)}</div></div>`
    )
    .join('');

  if (!expensesHtml) expensesHtml = '<p class="muted">Нет расходов</p>';

  const dailyHtml = daily.length
    ? daily
        .map(
          (d) => `
      <div class="daily-bar">
        <span class="daily-date">${TaxiReports.formatDate(d.day)}</span>
        <div class="daily-bar-track"><div class="daily-bar-fill" style="width:${(d.gross / maxDaily) * 100}%"></div></div>
        <span class="daily-amount">${TaxiReports.formatMoney(d.net)}</span>
      </div>`
        )
        .join('')
    : '<p class="muted">Нет данных за период</p>';

  const shiftsHtml = shiftReports.length
    ? shiftReports
        .map(
          ({ shift, stats: ss }) => `
      <div class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiReports.formatTime(shift.startedAt)} — ${shift.endedAt ? TaxiReports.formatTime(shift.endedAt) : 'активна'}</div>
          <div class="list-item-sub">${ss.totalTrips} поездок · ${TaxiReports.formatKm(ss.distanceKm)} · ${TaxiReports.formatDuration(ss.shiftMinutes)}</div>
        </div>
        <span class="list-item-amount positive">${TaxiReports.formatMoney(ss.net)}</span>
      </div>`
        )
        .join('')
    : '<p class="muted">Нет смен</p>';

  $('#report-content').innerHTML = `
    <div class="card report-section">
      <h2>${range.label}</h2>
      <div class="report-big">${TaxiReports.formatMoney(stats.net)}</div>
      <p class="muted">Чистый доход за период</p>
    </div>

    <div class="card report-section">
      <h3>Доходы</h3>
      <div class="report-grid">
        <div class="report-item"><div class="report-item-label">Всего заработано</div><div class="report-item-value">${TaxiReports.formatMoney(stats.gross)}</div></div>
        <div class="report-item"><div class="report-item-label">Поездок</div><div class="report-item-value">${stats.totalTrips}</div></div>
        <div class="report-item"><div class="report-item-label">Наличные</div><div class="report-item-value">${TaxiReports.formatMoney(stats.byPayment.cash)}</div></div>
        <div class="report-item"><div class="report-item-label">Карта</div><div class="report-item-value">${TaxiReports.formatMoney(stats.byPayment.card)}</div></div>
        <div class="report-item"><div class="report-item-label">Приложение</div><div class="report-item-value">${TaxiReports.formatMoney(stats.byPayment.app)}</div></div>
        <div class="report-item"><div class="report-item-label">Средний чек</div><div class="report-item-value">${TaxiReports.formatMoney(stats.avgTrip)}</div></div>
      </div>
    </div>

    <div class="card report-section">
      <h3>Расходы и комиссия</h3>
      <div class="report-grid">
        <div class="report-item"><div class="report-item-label">Комиссия (30₽×${stats.totalTrips})</div><div class="report-item-value red">−${TaxiReports.formatMoney(stats.commission)}</div></div>
        <div class="report-item"><div class="report-item-label">Все расходы</div><div class="report-item-value red">−${TaxiReports.formatMoney(stats.totalExpenses)}</div></div>
      </div>
      <div class="report-grid" style="margin-top:10px">${expensesHtml}</div>
    </div>

    <div class="card report-section">
      <h3>Километраж и эффективность</h3>
      <div class="report-grid">
        <div class="report-item"><div class="report-item-label">Пробег</div><div class="report-item-value">${TaxiReports.formatKm(stats.distanceKm)}</div></div>
        <div class="report-item"><div class="report-item-label">Время в сменах</div><div class="report-item-value">${TaxiReports.formatDuration(stats.shiftMinutes)}</div></div>
        <div class="report-item"><div class="report-item-label">Доход / км</div><div class="report-item-value">${TaxiReports.formatMoney(stats.incomePerKm)}</div></div>
        <div class="report-item"><div class="report-item-label">Чистыми / км</div><div class="report-item-value green">${TaxiReports.formatMoney(stats.netPerKm)}</div></div>
        <div class="report-item"><div class="report-item-label">Чистыми / час</div><div class="report-item-value green">${TaxiReports.formatMoney(stats.netPerHour)}</div></div>
        <div class="report-item"><div class="report-item-label">Смен</div><div class="report-item-value">${shiftReports.length}</div></div>
      </div>
    </div>

    <div class="card report-section">
      <h3>По дням</h3>
      ${dailyHtml}
    </div>

    <div class="card report-section">
      <h3>Смены за период</h3>
      ${shiftsHtml}
    </div>
  `;
}

async function renderHistory() {
  const shifts = await TaxiDB.getAllShifts();
  const container = $('#history-list');

  if (!shifts.length) {
    container.innerHTML = '<div class="empty-state">История пуста</div>';
    return;
  }

  const items = await Promise.all(
    shifts.map(async (s) => {
      const stats = await TaxiDB.getShiftStats(s.id);
      return { shift: s, stats };
    })
  );

  container.innerHTML = items
    .map(
      ({ shift, stats }) => `
    <div class="history-item" data-shift="${shift.id}">
      <div class="history-header">
        <span class="history-date">${TaxiReports.formatDateTime(shift.startedAt)}</span>
        <span class="history-status ${shift.status}">${shift.status === 'active' ? 'Активна' : 'Закрыта'}</span>
      </div>
      <div class="history-stats">
        <span>${stats.totalTrips} поездок</span>
        <span>${TaxiReports.formatKm(stats.distanceKm)}</span>
        <span class="history-net">${TaxiReports.formatMoney(stats.net)}</span>
      </div>
    </div>`
    )
    .join('');
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await refreshShiftUI();
  }
});

init();
