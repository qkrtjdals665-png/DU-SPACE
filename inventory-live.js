const SUPABASE_URL = 'https://hayfpcuacwkytbjwjdhm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_OnGhN5iA72Y6H0jmTu82tg_Vv9VJyI7';
const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const PLATFORM_COLORS = {
    '네이버': '#10a37f',
    '쿠팡': '#d94b55',
    '오늘의집': '#2d9bc1',
    '아이디어스': '#df7568'
};

let products = [];
let links = [];
let orders = [];
let platformCandidates = [];
let idusCandidates = [];
let dashboardRows = [];
let selectedCandidateIndexes = new Set();
let selectedIdusIndex = 0;
let currentFilter = 'all';

const fmt = value => Math.round(Number(value) || 0).toLocaleString('ko-KR');
const todayText = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const shortName = value => {
    const parts = String(value || '').split('|');
    const raw = parts.length > 1 ? parts[1] : parts[0];
    return raw.replace(/^\[[^\]]+\]\s*/, '').trim() || '상품명 없음';
};
const orderKey = item => `${item.platform}|${item.product}|${item.option || ''}`;
const daysAgo = dateText => {
    const target = new Date(`${dateText}T00:00:00`);
    const today = new Date(`${todayText()}T00:00:00`);
    return Math.floor((today - target) / 86400000);
};

async function fetchAll(table, select, configure = query => query) {
    const pageSize = 1000;
    let result = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await configure(db.from(table).select(select)).range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data?.length) break;
        result = result.concat(data);
        if (data.length < pageSize) break;
    }
    return result;
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function switchMode(mode) {
    document.querySelectorAll('.mode-tab').forEach(button =>
        button.classList.toggle('active', button.dataset.view === mode)
    );
    document.getElementById('dashboardView').classList.toggle('active', mode === 'dashboard');
    document.getElementById('mappingView').classList.toggle('active', mode === 'mapping');
    document.getElementById('idusView').classList.toggle('active', mode === 'idus');
}

function linksForOrder(order) {
    const exact = links.filter(link =>
        link.is_active !== false &&
        link.platform === order.platform &&
        link.product === order.product &&
        (link.option || '') === (order.option || '')
    );
    if (exact.length) return exact;
    return links.filter(link =>
        link.is_active !== false &&
        link.platform === order.platform &&
        link.product === order.product &&
        !(link.option || '')
    );
}

function buildInventoryRows() {
    const usage = new Map(products.map(product => [product.id, {
        sinceBaseline: 0,
        sold7: 0,
        sold14: 0,
        sold30: 0,
        activeDays: new Set(),
        platforms: new Set()
    }]));
    links.filter(link => link.is_active !== false).forEach(link => {
        usage.get(link.my_product_id)?.platforms.add(link.platform);
    });

    orders.forEach(order => {
        const age = daysAgo(order.order_date);
        if (age < 0) return;
        linksForOrder(order).forEach(link => {
            const bucket = usage.get(link.my_product_id);
            if (!bucket) return;
            const quantity = (Number(order.quantity) || 1) * (Number(link.quantity_per_order) || 1);
            const product = products.find(item => item.id === link.my_product_id);
            if (product && order.order_date > product.stock_as_of) bucket.sinceBaseline += quantity;
            if (age <= 6) bucket.sold7 += quantity;
            if (age <= 13) bucket.sold14 += quantity;
            if (age <= 29) bucket.sold30 += quantity;
            if (age <= 29 && quantity > 0) bucket.activeDays.add(order.order_date);
            bucket.platforms.add(order.platform);
        });
    });

    dashboardRows = products.filter(product => product.is_active !== false).map(product => {
        const bucket = usage.get(product.id);
        const currentStock = Number(product.stock || 0) - bucket.sinceBaseline;
        const avg7 = bucket.sold7 / 7;
        const avg14 = bucket.sold14 / 14;
        const avg30 = bucket.sold30 / 30;
        const forecastDaily = bucket.sold30 > 0 ? avg7 * .5 + avg14 * .3 + avg30 * .2 : 0;
        const daysRemaining = forecastDaily > 0 ? currentStock / forecastDaily : Infinity;
        const safeStock = Number(product.safe_stock || 0);
        const leadTime = Number(product.lead_time_days || 7);
        const targetDays = Number(product.target_cover_days || 30);
        const reorderLevel = Math.max(safeStock, Math.ceil(forecastDaily * (leadTime + 3)));
        const suggestedQty = Math.max(0, Math.ceil(forecastDaily * targetDays - currentStock));
        const low = currentStock <= reorderLevel;
        const confidence = bucket.sold30 >= 15 && bucket.activeDays.size >= 7
            ? '높음'
            : bucket.sold30 >= 5 ? '보통' : '낮음';
        const runout = Number.isFinite(daysRemaining)
            ? new Date(Date.now() + Math.max(0, Math.floor(daysRemaining)) * 86400000)
            : null;
        return {
            ...product,
            currentStock,
            sold7: bucket.sold7,
            sold14: bucket.sold14,
            sold30: bucket.sold30,
            forecastDaily,
            daysRemaining,
            reorderLevel,
            suggestedQty,
            confidence,
            low,
            platforms: [...bucket.platforms],
            runoutText: runout ? `${runout.getMonth() + 1}/${runout.getDate()}` : '-'
        };
    }).sort((a, b) => Number(b.low) - Number(a.low) || a.daysRemaining - b.daysRemaining);
}

function renderAlertStrip() {
    const alerts = dashboardRows.filter(row => row.low);
    if (!alerts.length) {
        return `<div class="alert-strip good">
            <div><div class="alert-title">현재 부족 경고가 없습니다</div><div class="alert-copy">안전재고와 최근 판매 추이를 기준으로 계산했습니다.</div></div>
            <div class="alert-actions"><button class="action-btn green" onclick="enableNotifications()">Windows 알림 켜기</button></div>
        </div>`;
    }
    const names = alerts.slice(0, 3).map(row => `${row.sku} ${fmt(row.currentStock)}개`).join(' · ');
    return `<div class="alert-strip">
        <div><div class="alert-title">발주 확인이 필요한 상품 ${alerts.length}개</div><div class="alert-copy">${escapeHtml(names)}${alerts.length > 3 ? ' 외' : ''}</div></div>
        <div class="alert-actions"><button class="action-btn red" onclick="applyFilter('low')">부족만 보기</button><button class="action-btn" onclick="enableNotifications()">Windows 알림</button></div>
    </div>`;
}

function rowStatus(row) {
    if (row.low) return { label: '발주 확인', className: 'low' };
    if (row.forecastDaily <= 0) return { label: '판매 데이터 부족', className: 'setup' };
    return { label: '정상', className: 'good' };
}

function applyFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(button => {
        button.style.cssText = button.dataset.filter === filter
            ? 'background:#20201e;color:#fff;border-color:#20201e'
            : '';
    });
    renderRows();
}

function renderRows() {
    let rows = dashboardRows;
    if (currentFilter === 'low') rows = rows.filter(row => row.low);
    if (currentFilter === 'selling') rows = rows.filter(row => row.sold30 > 0);
    const tbody = document.getElementById('inventoryBody');
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="10"><div class="empty">이 조건에 해당하는 제품이 없습니다.</div></td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(row => {
        const state = rowStatus(row);
        const platformDots = row.platforms.map(platform =>
            `<span class="platform-dot" style="--dot:${PLATFORM_COLORS[platform] || '#999'}" title="${escapeHtml(platform)}"></span>`
        ).join('');
        const remaining = Number.isFinite(row.daysRemaining) ? `${Math.max(0, Math.floor(row.daysRemaining))}일` : '-';
        return `<tr>
            <td>
                <div class="product-cell">
                    <span class="product-icon">📦</span>
                    <div style="min-width:0">
                        <div class="product-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</div>
                        <span class="sku-tag">${escapeHtml(row.sku)}</span>
                        <div class="product-meta">${platformDots}<span>${escapeHtml(row.platforms.join(' · ') || '연결 상품 없음')}</span></div>
                    </div>
                </div>
            </td>
            <td class="num">${fmt(row.sold30)}개</td>
            <td class="num">${row.forecastDaily.toFixed(1)}개</td>
            <td class="num">${fmt(row.currentStock)}개<div class="runout-date">기준 ${escapeHtml(row.stock_as_of)}</div></td>
            <td class="num">${fmt(row.safe_stock)}개</td>
            <td class="num">${remaining}<div class="runout-date">${row.runoutText === '-' ? '' : `${row.runoutText} 예상`}</div></td>
            <td class="num">${fmt(row.suggestedQty)}개</td>
            <td><span class="status ${state.className}">${state.label}</span></td>
            <td><span class="${row.confidence === '낮음' ? 'warning-badge' : 'linked-badge'}">${row.confidence}</span></td>
            <td><div class="inline-actions">
                <button class="ghost-btn" onclick="receiveStock(${row.id})">입고</button>
                <button class="ghost-btn" onclick="adjustStock(${row.id})">실사</button>
                <button class="ghost-btn" onclick="editSettings(${row.id})">설정</button>
            </div></td>
        </tr>`;
    }).join('');
}

function renderDashboard() {
    buildInventoryRows();
    const totalStock = dashboardRows.reduce((sum, row) => sum + row.currentStock, 0);
    const sold30 = dashboardRows.reduce((sum, row) => sum + row.sold30, 0);
    const lowCount = dashboardRows.filter(row => row.low).length;
    const mappedKeys = new Set(links.filter(link => link.is_active !== false).map(link => `${link.platform}|${link.product}|${link.option || ''}`));
    const recentCandidates = platformCandidates.filter(item => item.sold30 > 0);
    const unmappedCount = recentCandidates.filter(item => !mappedKeys.has(item.key)).length;
    document.getElementById('app').innerHTML = `
        ${renderAlertStrip()}
        <section class="kpi-grid">
            <article class="kpi"><div class="kpi-label">관리 제품</div><div class="kpi-value">${fmt(dashboardRows.length)}개</div><div class="kpi-note">제품번호 기준 통합 재고</div></article>
            <article class="kpi"><div class="kpi-label">현재 추정 재고</div><div class="kpi-value">${fmt(totalStock)}개</div><div class="kpi-note">기준 재고 - 이후 주문 차감</div></article>
            <article class="kpi"><div class="kpi-label">30일 판매수량</div><div class="kpi-value">${fmt(sold30)}개</div><div class="kpi-note">연결 완료 제품 기준</div></article>
            <article class="kpi"><div class="kpi-label">발주 확인</div><div class="kpi-value">${fmt(lowCount)}개</div><div class="kpi-note">미연결 주문상품 ${fmt(unmappedCount)}개</div></article>
        </section>
        <div class="method-note"><b>예상 소진 계산:</b> 최근 7일 50% + 14일 30% + 30일 20%의 가중 일평균을 사용합니다. AI 추측이 아니라 주문수량을 이용한 고정 공식이며, 표의 신뢰도는 판매 표본량에 따라 표시됩니다.</div>
        <section class="panel">
            <div class="panel-head">
                <div><div class="panel-title">제품번호별 재고 현황</div><div class="panel-desc">주문서가 추가되면 연결된 제품 재고와 소진 예상이 자동으로 다시 계산됩니다.</div></div>
                <div class="panel-actions">
                    <button class="filter-btn" data-filter="all" onclick="applyFilter('all')">전체</button>
                    <button class="filter-btn" data-filter="low" onclick="applyFilter('low')">발주 확인</button>
                    <button class="filter-btn" data-filter="selling" onclick="applyFilter('selling')">판매 중</button>
                    <button class="action-btn green" onclick="switchMode('mapping')">제품 연결</button>
                </div>
            </div>
            <div class="table-wrap">
                <table class="inventory-table" style="min-width:1180px">
                    <thead><tr><th>내부 제품</th><th>30일 판매</th><th>예상 일판매</th><th>현재 재고</th><th>안전재고</th><th>예상 소진</th><th>추천 입고</th><th>상태</th><th>신뢰도</th><th>관리</th></tr></thead>
                    <tbody id="inventoryBody"></tbody>
                </table>
            </div>
            <div class="foot-note"><span>ℹ️</span><span>현재 재고는 ‘기준일의 실제 재고’에서 그 다음 날부터 수집된 주문수량을 뺀 값입니다. 같은 날 실사 후 들어온 주문까지 나누어 계산할 수는 없으므로, 실사는 업무 마감 후 입력하는 것이 가장 정확합니다.</span></div>
        </section>`;
    applyFilter(currentFilter);
    notifyAlerts(false);
}

async function receiveStock(id) {
    const row = dashboardRows.find(item => item.id === id);
    if (!row) return;
    const value = prompt(`${row.name}\n입고된 수량을 입력하세요.`, String(Math.max(1, row.suggestedQty || 1)));
    if (value === null) return;
    const quantity = Number(value);
    if (!Number.isFinite(quantity) || quantity <= 0) return showToast('1개 이상의 입고 수량을 입력해주세요.');
    const { error } = await db.from('my_products').update({
        stock: Math.max(0, row.currentStock + quantity),
        stock_as_of: todayText(),
        updated_at: new Date().toISOString()
    }).eq('id', id);
    if (error) return showToast(`저장 실패: ${error.message}`);
    showToast(`${fmt(quantity)}개 입고를 반영했습니다.`);
    await loadData();
}

async function adjustStock(id) {
    const row = dashboardRows.find(item => item.id === id);
    if (!row) return;
    const value = prompt(`${row.name}\n지금 실제로 보유한 수량을 입력하세요.`, String(Math.max(0, row.currentStock)));
    if (value === null) return;
    const stock = Number(value);
    if (!Number.isFinite(stock) || stock < 0) return showToast('0개 이상의 실제 재고를 입력해주세요.');
    const { error } = await db.from('my_products').update({
        stock,
        stock_as_of: todayText(),
        updated_at: new Date().toISOString()
    }).eq('id', id);
    if (error) return showToast(`저장 실패: ${error.message}`);
    showToast('실제 재고와 기준일을 저장했습니다.');
    await loadData();
}

async function editSettings(id) {
    const row = dashboardRows.find(item => item.id === id);
    if (!row) return;
    const safe = prompt('안전재고 수량', String(row.safe_stock));
    if (safe === null) return;
    const lead = prompt('입고까지 걸리는 날짜', String(row.lead_time_days));
    if (lead === null) return;
    const target = prompt('입고 후 확보할 판매일수', String(row.target_cover_days));
    if (target === null) return;
    const values = [safe, lead, target].map(Number);
    if (values.some(value => !Number.isFinite(value) || value < 0) || values[2] <= 0) {
        return showToast('설정값을 올바른 숫자로 입력해주세요.');
    }
    const { error } = await db.from('my_products').update({
        safe_stock: values[0],
        lead_time_days: values[1],
        target_cover_days: values[2],
        updated_at: new Date().toISOString()
    }).eq('id', id);
    if (error) return showToast(`저장 실패: ${error.message}`);
    showToast('안전재고와 발주 기준을 저장했습니다.');
    await loadData();
}

function nextSku() {
    const used = new Set(products.map(product => product.sku));
    for (let number = 1; number < 10000; number++) {
        const sku = `DU-P-${String(number).padStart(3, '0')}`;
        if (!used.has(sku)) return sku;
    }
    return `DU-P-${Date.now()}`;
}

function setAutoSku() {
    document.getElementById('skuCode').value = nextSku();
    document.getElementById('existingProduct').value = '';
    syncExistingMode();
    updateGroupPreview();
}

function loadExistingProduct() {
    const id = Number(document.getElementById('existingProduct').value);
    const product = products.find(item => item.id === id);
    if (!product) {
        document.getElementById('skuCode').value = nextSku();
        document.getElementById('skuName').value = '';
        document.getElementById('skuStock').value = 0;
        document.getElementById('skuSafe').value = 10;
        document.getElementById('skuDate').value = todayText();
        document.getElementById('skuLead').value = 7;
        document.getElementById('skuTarget').value = 30;
    } else {
        const row = dashboardRows.find(item => item.id === id);
        document.getElementById('skuCode').value = product.sku;
        document.getElementById('skuName').value = product.name;
        document.getElementById('skuStock').value = Math.max(0, row?.currentStock ?? product.stock);
        document.getElementById('skuSafe').value = product.safe_stock;
        document.getElementById('skuDate').value = product.stock_as_of;
        document.getElementById('skuLead').value = product.lead_time_days;
        document.getElementById('skuTarget').value = product.target_cover_days;
    }
    syncExistingMode();
    updateGroupPreview();
}

function syncExistingMode() {
    const sku = document.getElementById('skuCode')?.value.trim().toUpperCase();
    const existing = products.find(product => product.sku === sku);
    const stockInput = document.getElementById('skuStock');
    const dateInput = document.getElementById('skuDate');
    if (stockInput) stockInput.disabled = Boolean(existing);
    if (dateInput) dateInput.disabled = Boolean(existing);
}

function toggleCandidate(index, checked) {
    if (checked) selectedCandidateIndexes.add(index);
    else selectedCandidateIndexes.delete(index);
    updateGroupPreview();
}

function renderCandidateList(query = '') {
    const list = document.getElementById('candidateList');
    if (!list) return;
    const keyword = query.trim().toLowerCase();
    const productNames = new Map(products.map(product => [product.id, product]));
    const filtered = platformCandidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => !keyword || `${candidate.platform} ${candidate.product} ${candidate.option}`.toLowerCase().includes(keyword))
        .slice(0, 80);
    list.innerHTML = filtered.map(({ candidate, index }) => {
        const mapped = linksForOrder(candidate).filter(link => link.mapping_role === 'base');
        const mappedLabel = mapped.map(link => productNames.get(link.my_product_id)?.sku).filter(Boolean).join(', ');
        return `<label class="candidate-row">
            <input type="checkbox" ${selectedCandidateIndexes.has(index) ? 'checked' : ''} onchange="toggleCandidate(${index},this.checked)">
            <span style="min-width:0">
                <span class="candidate-platform" style="--pf:${PLATFORM_COLORS[candidate.platform] || '#777'}">${escapeHtml(candidate.platform)} ${mappedLabel ? `<span class="linked-badge">연결 ${escapeHtml(mappedLabel)}</span>` : ''}</span>
                <span class="candidate-name">${escapeHtml(candidate.product)}</span>
                <span class="candidate-option">${escapeHtml(candidate.option || '옵션 전체')}</span>
            </span>
            <span class="candidate-sales">30일 ${fmt(candidate.sold30)}개</span>
        </label>`;
    }).join('') || '<div class="empty">검색 결과가 없습니다.</div>';
}

function updateGroupPreview() {
    const target = document.getElementById('groupPreview');
    if (!target) return;
    const selected = [...selectedCandidateIndexes].map(index => platformCandidates[index]).filter(Boolean);
    const sku = document.getElementById('skuCode')?.value.trim().toUpperCase() || '제품번호 없음';
    const name = document.getElementById('skuName')?.value.trim() || '제품명 없음';
    const totalSold = selected.reduce((sum, item) => sum + item.sold30, 0);
    const platforms = [...new Set(selected.map(item => item.platform))];
    const existing = products.find(product => product.sku === sku);
    target.innerHTML = `
        <div class="mapping-card-title">${existing ? '기존 제품에 연결' : '새 제품으로 묶기'}</div>
        <div class="mapping-card-copy">선택한 플랫폼 상품이 모두 아래 재고 하나를 사용합니다.</div>
        <div class="sku-code">${escapeHtml(sku)}</div>
        <div class="sku-name">${escapeHtml(name)}</div>
        <div class="result-grid">
            <div class="result-cell"><div class="result-label">연결 플랫폼</div><div class="result-value">${platforms.length}개</div></div>
            <div class="result-cell"><div class="result-label">연결 상품</div><div class="result-value">${selected.length}개</div></div>
            <div class="result-cell"><div class="result-label">30일 통합 판매</div><div class="result-value">${fmt(totalSold)}개</div></div>
            <div class="result-cell"><div class="result-label">현재 상태</div><div class="result-value">${existing ? '등록됨' : '신규'}</div></div>
        </div>
        <div class="linked-list">${selected.slice(0, 5).map(item => `
            <div class="linked-item"><span class="linked-pf">${escapeHtml(item.platform)}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(shortName(item.product))}</span></div>`
        ).join('') || '<div class="linked-item">가운데 목록에서 같은 실물 상품을 선택하세요.</div>'}</div>
        <button class="primary-preview" type="button" onclick="saveProductGroup()">${existing ? '선택 상품을 이 제품에 연결' : '제품 등록하고 연결'}</button>
        <div class="mapping-note"><span>ℹ️</span><span>저장 후 어느 플랫폼에서 팔려도 ${escapeHtml(sku)} 재고에서 함께 차감됩니다.</span></div>`;
}

function renderMapping() {
    selectedCandidateIndexes.clear();
    document.getElementById('mappingApp').innerHTML = `
        <section class="mapping-flow">
            <div class="flow-step"><span class="flow-no">1</span><div><div class="flow-title">내부 제품번호 만들기</div><div class="flow-copy">변하지 않는 우리 상품 번호</div></div></div>
            <span class="flow-arrow">→</span>
            <div class="flow-step"><span class="flow-no">2</span><div><div class="flow-title">플랫폼 상품 선택</div><div class="flow-copy">이름이 달라도 같은 실물 선택</div></div></div>
            <span class="flow-arrow">→</span>
            <div class="flow-step"><span class="flow-no">3</span><div><div class="flow-title">재고 하나로 통합</div><div class="flow-copy">어디서 팔려도 함께 차감</div></div></div>
        </section>
        <section class="mapping-layout">
            <article class="mapping-card">
                <div class="mapping-card-title">내부 제품</div>
                <div class="mapping-card-copy">기존 제품을 선택하면 재고는 유지하고 플랫폼 상품만 추가 연결합니다.</div>
                <div class="form-grid">
                    <div class="field span-2"><label>기존 제품 선택 · 새 제품이면 ‘새 제품 등록’</label><select id="existingProduct" onchange="loadExistingProduct()" style="width:100%;border:1px solid #deded8;border-radius:9px;background:#fafaf8;padding:9px 10px;font-size:11px"><option value="">새 제품 등록</option>${products.map(product => `<option value="${product.id}">${escapeHtml(product.sku)} · ${escapeHtml(product.name)}</option>`).join('')}</select></div>
                    <div class="field span-2"><label>제품번호</label><div class="field-row"><input id="skuCode" value="${nextSku()}" oninput="syncExistingMode();updateGroupPreview()"><button class="mini-btn" type="button" onclick="setAutoSku()">자동번호</button></div></div>
                    <div class="field span-2"><label>내부 제품명</label><input id="skuName" placeholder="예: 액막이 명태 자석형" oninput="updateGroupPreview()"></div>
                    <div class="field"><label>현재 실제 재고</label><input id="skuStock" type="number" min="0" value="0"></div>
                    <div class="field"><label>안전재고</label><input id="skuSafe" type="number" min="0" value="10"></div>
                    <div class="field"><label>재고 기준일</label><input id="skuDate" type="date" value="${todayText()}"></div>
                    <div class="field"><label>입고 소요일</label><input id="skuLead" type="number" min="0" value="7"></div>
                    <div class="field span-2"><label>목표 확보일</label><input id="skuTarget" type="number" min="1" value="30"></div>
                </div>
                <div class="mapping-note"><span>💡</span><span>재질·완제품 구성이 다르면 제품번호를 분리하고, 동일한 실물만 하나로 묶어주세요.</span></div>
            </article>
            <article class="mapping-card">
                <div class="mapping-card-title">플랫폼 상품 선택</div>
                <div class="mapping-card-copy">최근 30일 주문상품입니다. 같은 실물 상품을 여러 개 선택하세요.</div>
                <input class="candidate-search" type="search" placeholder="상품명·옵션·플랫폼 검색" oninput="renderCandidateList(this.value)">
                <div class="candidate-list" id="candidateList"></div>
            </article>
            <article class="mapping-card dark" id="groupPreview"></article>
        </section>`;
    renderCandidateList();
    syncExistingMode();
    updateGroupPreview();
}

async function saveProductGroup() {
    const sku = document.getElementById('skuCode').value.trim().toUpperCase();
    const name = document.getElementById('skuName').value.trim();
    const selected = [...selectedCandidateIndexes].map(index => platformCandidates[index]).filter(Boolean);
    if (!sku || !name) return showToast('제품번호와 내부 제품명을 입력해주세요.');
    if (!selected.length) return showToast('같은 재고로 묶을 플랫폼 상품을 선택해주세요.');
    const values = {
        stock: Number(document.getElementById('skuStock').value),
        safe_stock: Number(document.getElementById('skuSafe').value),
        stock_as_of: document.getElementById('skuDate').value || todayText(),
        lead_time_days: Number(document.getElementById('skuLead').value),
        target_cover_days: Number(document.getElementById('skuTarget').value)
    };
    if (Object.values(values).some(value => typeof value === 'number' && (!Number.isFinite(value) || value < 0)) || values.target_cover_days <= 0) {
        return showToast('재고와 설정값을 올바르게 입력해주세요.');
    }

    let product = products.find(item => item.sku === sku);
    if (!product) {
        const { data, error } = await db.from('my_products').insert({
            sku, name, ...values, cost: 0, is_active: true, updated_at: new Date().toISOString()
        }).select().single();
        if (error) return showToast(`제품 저장 실패: ${error.message}`);
        product = data;
    } else {
        const { error } = await db.from('my_products').update({
            name,
            safe_stock: values.safe_stock,
            lead_time_days: values.lead_time_days,
            target_cover_days: values.target_cover_days,
            updated_at: new Date().toISOString()
        }).eq('id', product.id);
        if (error) return showToast(`제품 수정 실패: ${error.message}`);
    }

    for (const candidate of selected) {
        const { error: deleteError } = await db.from('product_links')
            .delete()
            .eq('platform', candidate.platform)
            .eq('product', candidate.product)
            .eq('option', candidate.option || '')
            .eq('mapping_role', 'base');
        if (deleteError) return showToast(`기존 연결 정리 실패: ${deleteError.message}`);
        const { error: linkError } = await db.from('product_links').insert({
            my_product_id: product.id,
            platform: candidate.platform,
            product: candidate.product,
            option: candidate.option || '',
            quantity_per_order: 1,
            mapping_role: 'base',
            is_active: true,
            updated_at: new Date().toISOString()
        });
        if (linkError) return showToast(`상품 연결 실패: ${linkError.message}`);
    }
    showToast(`${sku}에 ${selected.length}개 상품을 연결했습니다.`);
    await loadData();
    switchMode('dashboard');
}

const cleanOptionValue = value => String(value || '')
    .replace(/\(\+[\d,]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function parseIdusOrder(item) {
    const product = String(item.product || '');
    const option = String(item.option || '');
    const segments = option.split(/\s*\/\s*/).map(segment => segment.trim()).filter(Boolean);
    let family = '기타 상품', familyCode = 'ITEM', material = '', mount = '', color = '', phrase = '';
    const addons = [];
    const ignored = [];

    if (product.includes('붉은말') || product.includes('홍마')) { family = '붉은말 액막이명태'; familyCode = 'MT-RED'; }
    else if (product.includes('차량용') || product.includes('룸미러')) { family = '차량용 액막이명태'; familyCode = 'MT-CAR'; }
    else if (product.includes('명태') || product.includes('북어')) { family = '현관용 액막이명태'; familyCode = 'MT'; }
    else if (product.includes('버니')) { family = '버니 홈캠거치대'; familyCode = 'BUNNY'; }
    else if (product.includes('클로버')) { family = '클로버 벽선반'; familyCode = 'CLOVER'; }

    segments.forEach(segment => {
        const colon = segment.indexOf(':');
        const key = (colon >= 0 ? segment.slice(0, colon) : segment).trim();
        const value = cleanOptionValue(colon >= 0 ? segment.slice(colon + 1) : '');
        const materialMatch = value.match(/메이플|월넛|편백/);
        if (materialMatch) material = materialMatch[0];
        if (key.includes('디자인')) {
            const mountMatch = value.match(/고리형|자석형/);
            if (mountMatch) mount = mountMatch[0];
            phrase = cleanOptionValue(value.split(' - ').slice(1).join(' - '));
        } else if (key.includes('팬던트 문구')) {
            if (value.includes('룸미러')) mount = '룸미러';
            if (value.includes('송풍구')) mount = '송풍구';
            phrase = cleanOptionValue(value.split(' - ').slice(1).join(' - '));
        } else if (key.includes('레드리본')) {
            if (value.includes('비구매')) ignored.push('레드리본 비구매');
            else addons.push({ sku: 'DU-RIBBON-RED', name: '레드리본', qty: 1 });
        } else if (key.includes('복주머니')) {
            if (value.includes('비구매')) ignored.push('복주머니 비구매');
            else addons.push({ sku: 'DU-POUCH-GOLD', name: '황금 복주머니·엽전', qty: 1 });
        } else if (key.includes('철판 스티커')) {
            if (value.includes('비구매')) ignored.push('철판 스티커 비구매');
            else addons.push({ sku: 'DU-STEEL-STICKER', name: '철판 스티커', qty: 1 });
        } else if (key.includes('포토리뷰')) ignored.push('포토리뷰 약속');
        else if (key.includes('색상')) color = value;
        else if (key.includes('옵션') && value.includes('없음')) ignored.push('추가 옵션 없음');
    });

    if (phrase) ignored.push(`각인·문구: ${phrase}`);
    const materialCode = { '메이플': 'MAP', '월넛': 'WAL', '편백': 'HIN' }[material] || 'GEN';
    const mountCode = { '고리형': 'HOOK', '자석형': 'MAG', '룸미러': 'MIRROR', '송풍구': 'VENT' }[mount] || 'BASE';
    const colorCode = { '화이트': 'WHT', '오트밀': 'OAT' }[color] || '';
    const baseSku = ['DU', familyCode, materialCode, mountCode, colorCode].filter(Boolean).join('-');
    const attributes = [
        material && { label: `재질 · ${material}`, className: 'green' },
        mount && { label: `부착 · ${mount}`, className: 'green' },
        color && { label: `색상 · ${color}`, className: 'green' },
        phrase && { label: `문구 · ${phrase}`, className: 'amber' }
    ].filter(Boolean);
    const confidence = familyCode !== 'ITEM' && (material || mount || color || familyCode === 'MT-RED') ? '자동 분해 완료' : '확인 필요';
    return {
        family,
        baseSku,
        baseName: [family, material, mount, color].filter(Boolean).join(' · '),
        attributes,
        addons,
        ignored: [...new Set(ignored)],
        confidence
    };
}

function selectIdus(index) {
    selectedIdusIndex = index;
    renderIdusList(document.getElementById('idusSearch')?.value || '');
    renderIdusDetail();
}

function renderIdusList(query = '') {
    const keyword = query.trim().toLowerCase();
    const list = document.getElementById('idusList');
    if (!list) return;
    const filtered = idusCandidates
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !keyword || `${item.product} ${item.option}`.toLowerCase().includes(keyword))
        .slice(0, 80);
    list.innerHTML = filtered.map(({ item, index }) => {
        const hasBase = linksForOrder({ platform: '아이디어스', ...item }).some(link => link.mapping_role === 'base');
        return `<button class="parser-order ${index === selectedIdusIndex ? 'active' : ''}" type="button" onclick="selectIdus(${index})">
            <span class="parser-order-name">${escapeHtml(item.product)} ${hasBase ? '<span class="linked-badge">연결됨</span>' : ''}</span>
            <span class="parser-order-option">${escapeHtml(item.option || '옵션 없음')}</span>
            <span class="parser-order-meta"><span>${escapeHtml(item.lastDate)}</span><span>${fmt(item.soldQty)}개 판매</span></span>
        </button>`;
    }).join('') || '<div class="empty">검색 결과가 없습니다.</div>';
}

function idusMovements(item) {
    const parsed = parseIdusOrder(item);
    const map = new Map();
    [{ sku: parsed.baseSku, name: parsed.baseName, qty: 1, role: 'base' }, ...parsed.addons.map(addon => ({ ...addon, role: 'component' }))].forEach(movement => {
        const previous = map.get(movement.sku);
        if (previous) previous.qty += movement.qty;
        else map.set(movement.sku, { ...movement });
    });
    return { parsed, movements: [...map.values()] };
}

function renderIdusDetail() {
    const item = idusCandidates[selectedIdusIndex];
    if (!item) return;
    const { parsed, movements } = idusMovements(item);
    const attributeChips = parsed.attributes.map(attribute => `<span class="parse-chip ${attribute.className}">${escapeHtml(attribute.label)}</span>`).join('');
    const addonChips = parsed.addons.map(addon => `<span class="parse-chip green">+ ${escapeHtml(addon.name)}</span>`).join('');
    const ignoredChips = parsed.ignored.map(label => `<span class="parse-chip gray">${escapeHtml(label)}</span>`).join('');
    document.getElementById('idusDetail').innerHTML = `
        <div class="mapping-card-title">긴 옵션을 이렇게 나눕니다</div>
        <div class="mapping-card-copy">원본은 그대로 두고 재고에 필요한 값만 제품번호로 분리합니다.</div>
        <div class="raw-box">
            <div class="raw-label">원본 상품명</div><div class="raw-product">${escapeHtml(item.product)}</div>
            <div class="raw-label">원본 옵션</div><div class="raw-option">${escapeHtml(item.option || '옵션 없음')}</div>
        </div>
        <div class="parse-section"><div class="parse-title"><span>① 기본 제품</span><span class="parse-count">주문수량만큼 차감</span></div><div class="chip-wrap"><span class="parse-chip">${escapeHtml(parsed.family)}</span>${attributeChips}</div></div>
        <div class="parse-section"><div class="parse-title"><span>② 추가 구성품</span><span class="parse-count">${parsed.addons.length}개 항목</span></div><div class="chip-wrap">${addonChips || '<span class="parse-chip gray">추가 차감 없음</span>'}</div></div>
        <div class="parse-section"><div class="parse-title"><span>③ 재고에서 제외</span><span class="parse-count">표시만 보관</span></div><div class="chip-wrap">${ignoredChips || '<span class="parse-chip gray">제외 항목 없음</span>'}</div></div>
        <div class="parse-arrow">↓</div>
        <div class="sku-result"><div class="sku-result-label">자동 생성 기본 제품번호</div><div class="sku-result-code">${escapeHtml(parsed.baseSku)}</div><div class="sku-result-name">${escapeHtml(parsed.baseName)}</div></div>`;

    document.getElementById('idusMovement').innerHTML = `
        <div class="mapping-card-title">제품 등록 및 재고 차감</div>
        <div class="mapping-card-copy">처음 보는 제품만 현재 재고와 안전재고를 입력합니다. 등록된 제품은 기존 재고를 유지합니다.</div>
        <div style="display:grid;grid-template-columns:1fr 76px 76px;gap:6px"><span></span><span class="movement-head">현재 재고</span><span class="movement-head">안전재고</span></div>
        <div class="movement-list">${movements.map((movement, index) => {
            const existing = products.find(product => product.sku === movement.sku);
            return `<div class="movement-stock">
                <div><div class="movement-sku">${escapeHtml(movement.sku)} ${existing ? '<span class="linked-badge">등록됨</span>' : ''}</div><div class="movement-name">${escapeHtml(movement.name)} · 주문 1개당 ${movement.qty}개 차감</div></div>
                <input id="idusStock-${index}" type="number" min="0" value="${existing ? Math.max(0, dashboardRows.find(row => row.id === existing.id)?.currentStock ?? existing.stock) : 0}" ${existing ? 'disabled' : ''}>
                <input id="idusSafe-${index}" type="number" min="0" value="${existing ? existing.safe_stock : Math.max(3, Math.ceil(item.soldQty / 30 * 14 * movement.qty))}" ${existing ? 'disabled' : ''}>
            </div>`;
        }).join('')}</div>
        <div class="ignored-note">맞춤문구, 포토리뷰 선택, ‘비구매’ 항목은 주문 원본에는 남지만 재고에서는 차감하지 않습니다.</div>
        <div class="confidence"><span class="confidence-dot"></span>${parsed.confidence} · 원본 주문은 변경하지 않음</div>
        <button class="primary-preview" style="margin-top:14px" type="button" onclick="saveIdusMapping()">제품 등록 및 옵션 연결</button>`;
}

function renderIdusParser() {
    if (!idusCandidates.length) {
        document.getElementById('idusApp').innerHTML = '<div class="empty">아이디어스 주문 데이터가 없습니다.</div>';
        return;
    }
    selectedIdusIndex = Math.min(selectedIdusIndex, idusCandidates.length - 1);
    document.getElementById('idusApp').innerHTML = `
        <section class="parser-layout">
            <article class="parser-card">
                <div class="mapping-card-title">아이디어스 실제 옵션</div>
                <div class="mapping-card-copy">주문 ${fmt(idusCandidates.reduce((sum, item) => sum + item.rowCount, 0))}건에서 같은 옵션을 묶었습니다. 연결할 주문 형태를 선택하세요.</div>
                <input class="candidate-search" id="idusSearch" type="search" placeholder="상품명·옵션 검색" oninput="renderIdusList(this.value)">
                <div class="parser-list" id="idusList"></div>
            </article>
            <article class="parser-card" id="idusDetail"></article>
            <article class="parser-card dark" id="idusMovement"></article>
        </section>`;
    renderIdusList();
    renderIdusDetail();
}

async function ensureProduct(movement, index) {
    let product = products.find(item => item.sku === movement.sku);
    if (product) return product;
    const stock = Number(document.getElementById(`idusStock-${index}`).value);
    const safeStock = Number(document.getElementById(`idusSafe-${index}`).value);
    if (![stock, safeStock].every(value => Number.isFinite(value) && value >= 0)) throw new Error(`${movement.sku} 재고를 확인해주세요.`);
    const { data, error } = await db.from('my_products').insert({
        sku: movement.sku,
        name: movement.name,
        stock,
        safe_stock: safeStock,
        stock_as_of: todayText(),
        lead_time_days: 7,
        target_cover_days: 30,
        cost: 0,
        is_active: true,
        updated_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    return data;
}

async function saveIdusMapping() {
    const item = idusCandidates[selectedIdusIndex];
    if (!item) return;
    const { parsed, movements } = idusMovements(item);
    if (parsed.confidence === '확인 필요' && !confirm('자동 분해 신뢰도가 낮습니다. 제품번호와 차감 항목을 확인했나요?')) return;
    try {
        const resolved = [];
        for (let index = 0; index < movements.length; index++) {
            resolved.push({ movement: movements[index], product: await ensureProduct(movements[index], index) });
        }
        const baseDelete = await db.from('product_links')
            .delete()
            .eq('platform', '아이디어스')
            .eq('product', item.product)
            .eq('option', item.option || '')
            .eq('mapping_role', 'base');
        if (baseDelete.error) throw baseDelete.error;
        const componentDelete = await db.from('product_links')
            .delete()
            .eq('platform', '아이디어스')
            .eq('product', item.product)
            .eq('option', item.option || '')
            .eq('mapping_role', 'component');
        if (componentDelete.error) throw componentDelete.error;
        const payload = resolved.map(({ movement, product }) => ({
            my_product_id: product.id,
            platform: '아이디어스',
            product: item.product,
            option: item.option || '',
            quantity_per_order: movement.qty,
            mapping_role: movement.role,
            is_active: true,
            updated_at: new Date().toISOString()
        }));
        const { error } = await db.from('product_links').insert(payload);
        if (error) throw error;
        showToast(`${parsed.baseSku}와 구성품 연결을 저장했습니다.`);
        await loadData();
        switchMode('dashboard');
    } catch (error) {
        showToast(`저장 실패: ${error.message}`);
    }
}

function notificationApi() {
    try { return window.top.Notification || window.Notification; }
    catch { return window.Notification; }
}

async function enableNotifications() {
    const API = notificationApi();
    if (!API) return showToast('이 브라우저는 알림을 지원하지 않습니다.');
    const permission = await API.requestPermission();
    if (permission !== 'granted') return showToast('브라우저에서 알림 권한을 허용해야 합니다.');
    showToast('재고 부족 Windows 알림을 켰습니다.');
    notifyAlerts(true);
}

function notifyAlerts(force) {
    const API = notificationApi();
    if (!API || API.permission !== 'granted') return;
    const alerts = dashboardRows.filter(row => row.low);
    if (!alerts.length) return;
    const key = `du-inventory-alert-${todayText()}-${alerts.map(row => `${row.id}:${Math.floor(row.currentStock)}`).join(',')}`;
    if (!force && localStorage.getItem(key)) return;
    try {
        new API('DU-SPACE 재고 알림', {
            body: `${alerts.length}개 제품의 발주 확인이 필요합니다. ${alerts.slice(0, 2).map(row => `${row.sku} ${fmt(row.currentStock)}개`).join(', ')}`,
            tag: 'du-inventory-low-stock'
        });
        localStorage.setItem(key, '1');
    } catch (error) {
        console.warn('Notification failed', error);
    }
}

function buildCandidates() {
    const map = new Map();
    orders.forEach(order => {
        const age = daysAgo(order.order_date);
        if (age < 0 || age > 29) return;
        const key = orderKey(order);
        if (!map.has(key)) map.set(key, {
            key,
            platform: order.platform,
            product: order.product,
            option: order.option || '',
            sold30: 0
        });
        map.get(key).sold30 += Number(order.quantity) || 1;
    });
    platformCandidates = [...map.values()].sort((a, b) => b.sold30 - a.sold30);

    const idusMap = new Map();
    orders.filter(order => order.platform === '아이디어스').forEach(order => {
        const key = `${order.product}|${order.option || ''}`;
        if (!idusMap.has(key)) idusMap.set(key, {
            key,
            platform: '아이디어스',
            product: order.product,
            option: order.option || '',
            soldQty: 0,
            rowCount: 0,
            lastDate: order.order_date
        });
        const item = idusMap.get(key);
        item.soldQty += Number(order.quantity) || 1;
        item.rowCount++;
        if (order.order_date > item.lastDate) item.lastDate = order.order_date;
    });
    idusCandidates = [...idusMap.values()].sort((a, b) =>
        b.lastDate.localeCompare(a.lastDate) || b.soldQty - a.soldQty
    );
}

async function loadData() {
    try {
        [products, links, orders] = await Promise.all([
            fetchAll('my_products', 'id,sku,name,stock,safe_stock,cost,stock_as_of,lead_time_days,target_cover_days,is_active,updated_at', query => query.order('id')),
            fetchAll('product_links', 'id,my_product_id,platform,product,option,quantity_per_order,mapping_role,is_active,updated_at', query => query.order('id')),
            fetchAll('orders', 'platform,order_date,order_no,product,option,quantity', query => query.order('order_date', { ascending: false }))
        ]);
        buildCandidates();
        renderDashboard();
        renderMapping();
        renderIdusParser();
    } catch (error) {
        console.error(error);
        document.getElementById('app').innerHTML = `<div class="error">재고 데이터를 불러오지 못했습니다.<br>${escapeHtml(error.message || '')}</div>`;
    }
}

loadData();
