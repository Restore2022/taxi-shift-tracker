const tracker = new GpsTracker();
let activeShift = null;
let liveTimer = null;
let currentPeriod = 'today';
let pendingSummary = null;

const SETTINGS_KEY = 'taxiSmenaSettings';
const QUICK_AMOUNTS = [150, 200, 250, 300, 500, 550];

function $(sel) {
  return document.querySelector(sel);
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = value === 'light' ? '#eef2f6' : '#12161c';
  }
  saveSettings({ theme: value });
}

function vibrate(pattern = [30, 40, 30]) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2200);
}

function openModal(id) {
  $(`#${id}`).classList.remove('hidden');
}

function closeModal(id) {
  $(`#${id}`).classList.add('hidden');
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
  const settings = loadSettings();
  applyTheme(settings.theme || 'dark');
  if (settings.goal) $('#goal-input').value = settings.goal;
  bindEvents();
  await refreshShiftUI();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  $('#btn-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'light' ? 'dark' : 'light');
    vibrate(20);
  });

  $('#btn-start-shift').addEventListener('click', startShiftHandler);
  $('#btn-end-shift').addEventListener('click', endShiftHandler);
  $('#btn-summary-done').addEventListener('click', finishSummary);

  $('#btn-open-trip').addEventListener('click', () => {
    $('#trip-amount').value = '';
    openModal('modal-trip');
    setTimeout(() => $('#trip-amount').focus(), 150);
  });

  $('#btn-open-expense').addEventListener('click', () => {
    $('#expense-amount').value = '';
    $('#expense-note').value = '';
    openModal('modal-expense');
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });

  $('#quick-amounts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-amount]');
    if (!btn) return;
    $('#trip-amount').value = btn.dataset.amount;
    vibrate(15);
  });

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
    const goal = Number($('#goal-input').value) || 0;
    saveSettings({ goal });

    const perm = await requestGeoPermission();
    if (!perm) {
      showToast('Нужен доступ к геолокации для пробега');
      return;
    }

    activeShift = await TaxiDB.startShift();
    if (goal > 0) {
      activeShift.goal = goal;
      await TaxiDB.updateShiftMeta(activeShift.id, { goal });
    }

    await tracker.start(activeShift.id, 0);
    setGpsStatus('active', 'GPS: поиск сигнала...');
    vibrate([20, 30, 40]);
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

  const stats = await TaxiDB.getShiftStats(activeShift.id);
  const km = activeShift.distanceKm || tracker.getDistance();
  const goal = activeShift.goal || loadSettings().goal || 0;

  pendingSummary = {
    ...stats,
    distanceKm: km,
    goal,
    startedAt: activeShift.startedAt,
    endedAt: Date.now()
  };

  tracker.stop();
  await TaxiDB.endShift(activeShift.id);
  clearInterval(liveTimer);
  liveTimer = null;
  activeShift = null;

  vibrate([40, 50, 40]);
  showShiftSummary(pendingSummary);
}

function showShiftSummary(summary) {
  $('#no-shift').classList.add('hidden');
  $('#active-shift').classList.add('hidden');
  $('#shift-badge').classList.add('hidden');
  $('#shift-summary').classList.remove('hidden');

  $('#summary-net').textContent = TaxiReports.formatMoney(summary.net);
  $('#summary-grid').innerHTML = `
    <div class="summary-item"><span>Время</span><strong>${TaxiReports.formatDuration(summary.shiftMinutes)}</strong></div>
    <div class="summary-item"><span>Пробег</span><strong>${TaxiReports.formatKm(summary.distanceKm)}</strong></div>
    <div class="summary-item"><span>Поездок</span><strong>${summary.totalTrips}</strong></div>
    <div class="summary-item"><span>Всего</span><strong>${TaxiReports.formatMoney(summary.gross)}</strong></div>
    <div class="summary-item"><span>Наличные</span><strong>${TaxiReports.formatMoney(summary.byPayment.cash)}</strong></div>
    <div class="summary-item"><span>Карта</span><strong>${TaxiReports.formatMoney(summary.byPayment.card)}</strong></div>
    <div class="summary-item"><span>Приложение</span><strong>${TaxiReports.formatMoney(summary.byPayment.app)}</strong></div>
    <div class="summary-item"><span>Комиссия</span><strong>−${TaxiReports.formatMoney(summary.commission)}</strong></div>
    <div class="summary-item"><span>Расходы</span><strong>−${TaxiReports.formatMoney(summary.totalExpenses)}</strong></div>
    <div class="summary-item"><span>Чистыми / час</span><strong>${TaxiReports.formatMoney(summary.netPerHour)}</strong></div>
  `;

  const goalEl = $('#summary-goal');
  if (summary.goal > 0) {
    const ok = summary.net >= summary.goal;
    goalEl.classList.remove('hidden');
    goalEl.textContent = ok
      ? `Цель ${TaxiReports.formatMoney(summary.goal)} достигнута`
      : `До цели ${TaxiReports.formatMoney(summary.goal - summary.net)}`;
  } else {
    goalEl.classList.add('hidden');
  }
}

function finishSummary() {
  pendingSummary = null;
  $('#shift-summary').classList.add('hidden');
  $('#no-shift').classList.remove('hidden');
  showToast('Можно открыть новую смену');
}

async function addTripHandler(e) {
  e.preventDefault();
  if (!activeShift) return;

  const amount = $('#trip-amount').value;
  const payment = document.querySelector('input[name="payment"]:checked').value;

  await TaxiDB.addTrip(activeShift.id, amount, payment);
  closeModal('modal-trip');
  vibrate([25, 20, 25]);
  showToast(`+${amount} ₽`);
  await refreshShiftLists();
  await updateLiveStats();
}

async function addExpenseHandler(e) {
  e.preventDefault();
  if (!activeShift) return;

  const category = document.querySelector('input[name="expense-cat"]:checked').value;
  const amount = $('#expense-amount').value;
  const note = $('#expense-note').value;

  await TaxiDB.addExpense(activeShift.id, category, amount, note);
  closeModal('modal-expense');
  vibrate(25);
  showToast('Расход добавлен');
  await refreshShiftLists();
  await updateLiveStats();
}

async function refreshShiftUI() {
  if (pendingSummary) {
    showShiftSummary(pendingSummary);
    return;
  }

  activeShift = await TaxiDB.getActiveShift();
  const badge = $('#shift-badge');
  $('#shift-summary').classList.add('hidden');

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
  const km = activeShift.distanceKm || tracker.getDistance();
  $('#live-km').textContent = TaxiReports.formatKm(km);
  $('#live-gross').textContent = TaxiReports.formatMoney(stats.gross);
  $('#live-net').textContent = TaxiReports.formatMoney(stats.net);
  $('#live-commission').textContent = TaxiReports.formatMoney(stats.commission);
  $('#live-trips-count').textContent = `${stats.totalTrips} ${pluralTrips(stats.totalTrips)}`;
  $('#trip-count').textContent = stats.totalTrips;

  const goal = activeShift.goal || loadSettings().goal || 0;
  const goalBlock = $('#goal-block');
  if (goal > 0) {
    goalBlock.classList.remove('hidden');
    const pct = Math.min(100, Math.round((stats.net / goal) * 100));
    $('#goal-fill').style.width = `${pct}%`;
    $('#goal-text').textContent = `${TaxiReports.formatMoney(stats.net)} / ${TaxiReports.formatMoney(goal)}`;
  } else {
    goalBlock.classList.add('hidden');
  }
}

function pluralTrips(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'поездка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'поездки';
  return 'поездок';
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
      .slice(0, 8)
      .map(
        (t) => `
      <li class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiReports.formatMoney(t.amount)}</div>
          <div class="list-item-sub">${TaxiDB.PAYMENT_LABELS[t.paymentMethod]} · −${t.commission} ₽ · ${TaxiReports.formatTime(t.createdAt)}</div>
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
      .slice(0, 8)
      .map(
        (e) => `
      <li class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiDB.EXPENSE_LABELS[e.category] || e.category}</div>
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

  container.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => openHistoryDetail(el.dataset.shift));
  });
}

async function openHistoryDetail(shiftId) {
  const [shift, trips, expenses, stats] = await Promise.all([
    TaxiDB.getShift(shiftId),
    TaxiDB.getTripsByShift(shiftId),
    TaxiDB.getExpensesByShift(shiftId),
    TaxiDB.getShiftStats(shiftId)
  ]);

  if (!shift) return;

  const tripsHtml = trips.length
    ? trips
        .map(
          (t) => `
      <li class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiReports.formatMoney(t.amount)}</div>
          <div class="list-item-sub">${TaxiDB.PAYMENT_LABELS[t.paymentMethod]} · ${TaxiReports.formatTime(t.createdAt)}</div>
        </div>
      </li>`
        )
        .join('')
    : '<li class="empty-state">Нет поездок</li>';

  const expensesHtml = expenses.length
    ? expenses
        .map(
          (e) => `
      <li class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${TaxiDB.EXPENSE_LABELS[e.category] || e.category}</div>
          <div class="list-item-sub">${e.note || '—'} · ${TaxiReports.formatTime(e.createdAt)}</div>
        </div>
        <span class="list-item-amount negative">−${e.amount} ₽</span>
      </li>`
        )
        .join('')
    : '<li class="empty-state">Нет расходов</li>';

  $('#history-detail').innerHTML = `
    <h2>${TaxiReports.formatDate(shift.startedAt)}</h2>
    <div class="detail-meta">
      ${TaxiReports.formatTime(shift.startedAt)} — ${shift.endedAt ? TaxiReports.formatTime(shift.endedAt) : 'сейчас'}
      · ${TaxiReports.formatDuration(stats.shiftMinutes)}
      · ${TaxiReports.formatKm(stats.distanceKm)}
    </div>
    <div class="detail-net">${TaxiReports.formatMoney(stats.net)}</div>
    <div class="summary-grid" style="margin-bottom:16px">
      <div class="summary-item"><span>Всего</span><strong>${TaxiReports.formatMoney(stats.gross)}</strong></div>
      <div class="summary-item"><span>Поездок</span><strong>${stats.totalTrips}</strong></div>
      <div class="summary-item"><span>Комиссия</span><strong>−${TaxiReports.formatMoney(stats.commission)}</strong></div>
      <div class="summary-item"><span>Расходы</span><strong>−${TaxiReports.formatMoney(stats.totalExpenses)}</strong></div>
    </div>
    <div class="card soft" style="margin:0 0 12px">
      <h2>Поездки</h2>
      <ul class="list">${tripsHtml}</ul>
    </div>
    <div class="card soft" style="margin:0 0 12px">
      <h2>Расходы</h2>
      <ul class="list">${expensesHtml}</ul>
    </div>
  `;

  openModal('modal-history');
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await refreshShiftUI();
  }
});

init();
