// Persian store artwork scenes, maintained against the mobile source.
// Names, balances and notes below are fictional demonstration data. No customer
// records, telephone numbers, live invite links or backend calls are used.
// Product chrome stays neutral; entry actions use the app's apricot/sage tints.
// Marketing panels own the blue accents. Displayed numerals stay Latin.

const d = (n) => `calc(var(--k)*${n}px)`;
const di = (n) => `calc(var(--k)*(${n}px + var(--ib)))`;

function createScenes(S) {
  const { app, ion, material, money, statusBar } = S;
  const bar = (opts) => opts.bar ?? statusBar();
  const header = (title) =>
    `<div class="shdr scene-header"><div class="shdr-btn">${ion("chevron-forward", 26, app.textEmphasis)}</div><div class="shdr-title" dir="rtl">${title}</div><div class="shdr-btn"></div></div>`;
  const divider = '<div class="div"></div>';
  // The source uses native Stack presentation:"modal" for search/add-entry,
  // exactly as for Add Customer. iOS supplies the card/backdrop; Android's
  // modal occupies the viewport. No custom grabber exists in the app.
  const modalBar = (opts) => (opts.platform === "ios" ? "" : bar(opts));
  const nativeModal = (content, opts, underlying) =>
    opts.platform === "ios"
      ? `<div class="scene-native-modal"><div class="scene-modal-underlay">${underlying}</div><div class="scene-modal-dim"></div><div class="scene-modal-status">${statusBar(true)}</div><div class="scene-modal-card">${content}</div></div>`
      : content;

  function screenHome(opts = {}) {
    const rows = [
      ["احمد ولی", "2 ساعت پیش", "12,500"],
      ["گل رحمان", "دیروز", "8,750"],
      ["فاطمه نوری", "3 روز پیش", "3,200"],
      ["نصیر احمدزی", "1 هفته پیش", "1,400"],
      ["نور محمد", "دیروز", null],
      ["ذبیح‌الله", "3 روز پیش", null],
    ];
    const visibleRows = opts.compact ? rows.slice(0, 4) : rows;
    return `<div class="home rtl store-ui">${bar(opts)}
      <div class="hdr"><div class="hdr-title"><span class="shop" dir="rtl">مارکیت برادران</span>${ion("chevron-down", 16, app.textSubtle)}</div><div class="hdr-sp"></div><div class="bell">${ion("notifications-outline", 22, app.textEmphasis)}</div><div class="pchip">م</div></div>
      <div class="tabs"><div class="tab tab-on">وصول</div><div class="tab">پرداخت</div></div>
      <div class="total"><div class="total-lbl" dir="rtl">قابل وصول</div><div class="total-row">${money("25,850", "collect")}</div><div class="total-sub" dir="rtl">از 4 نفر</div></div>
      <div class="card">${visibleRows.map(([name, when, amount]) => `<div class="prow"><div class="pleft"><div class="pname" dir="rtl">${name}</div><div class="psub" dir="rtl">${when}</div></div><div class="pamt">${amount ? money(amount) : ion("checkmark", 22, app.textSubtle)}</div></div>`).join(divider)}</div>
      <div class="dock"><div class="dock-search">${ion("search-outline", 22, app.textSubtle)}<span class="ph" dir="rtl">جستجوی مشتری‌ها</span></div><div class="dock-add">${ion("add", 28, app.bg)}</div></div>
    </div>`;
  }

  function screenPerson(opts = {}) {
    const action = (kind, label, arrow) => {
      const token = kind === "received" ? "entryActionReceived" : "entryActionGave";
      return `<div class="abtn" data-entry-action="${kind}" style="background:${app[token]};color:${app[`${token}Text`]}"><span class="coin" style="background:${app[`${token}Coin`]}">${ion(arrow, 16, app[`${token}Text`])}</span><span>${label}</span></div>`;
    };
    const entry = (gave, amount, note, when) =>
      `<div class="erow"><div class="etile" style="background:${gave ? app.payBg : app.collectBg}">${ion(gave ? "arrow-up-outline" : "arrow-down-outline", 16, gave ? app.payStrong : app.collectStrong)}</div><div class="emid"><div class="etop"><div class="eamt">${money(amount)}</div><div class="emeta"><span class="ewhen" dir="rtl">${when}</span></div></div>${note ? `<div class="enote" dir="rtl">${note}</div>` : ""}</div></div>`;
    const flow = (label, amount) =>
      `<div class="flow"><div class="flow-lbl" dir="rtl">${label}</div><div class="flow-amt">${amount}</div></div>`;
    return `<div class="person rtl store-ui">${bar(opts)}
      <div class="pnav"><div class="navbtn">${ion("chevron-forward", 26, app.textEmphasis)}</div><div class="pnav-actions"><div class="navwa">${ion("logo-whatsapp", 26, app.action)}</div><div class="navmore">${ion("ellipsis-horizontal", 22, app.textEmphasis)}</div></div></div>
      <div class="pinfo"><div class="scene-identity"><div class="pd-namerow"><span class="pd-name" dir="rtl">احمد ولی</span>${material("verified", 20, app.sharedAccount)}</div><span class="scene-group" dir="rtl">مشتریان</span></div>
        <div class="pd-overview"><div class="pd-balance"><div class="pd-chip" dir="rtl">از شما قرضدار</div><div class="pd-bal">${money("12,500", "collect")}</div></div><div class="pd-flows">${flow("دادم (2)", "15,000")}${flow("گرفتم (1)", "2,500")}</div></div>
      </div>
      <div class="ecard">${entry(true, "5,000", "روغن و برنج", "2 ساعت پیش")}${divider}${entry(false, "2,500", "", "دیروز")}${divider}${entry(true, "10,000", "آرد", "4 روز پیش")}</div>
      <div class="pdock"><div class="pdock-row">${action("received", "گرفتم", "arrow-down-outline")}${action("gave", "دادم", "arrow-up-outline")}</div>
        <div class="psearch"><div class="psearch-box">${ion("search-outline", 16, app.textSubtle)}<span dir="rtl">جستجو: یادداشت یا مقدار</span></div><div class="pdate">${ion("calendar-outline", 22, app.textSubtle)}</div></div>
      </div>
    </div>`;
  }

  // A valid add-entry state after the keyboard has been dismissed. Native
  // keyboards differ by platform and user settings, so none is fabricated.
  function screenEntry(opts = {}) {
    const content = `<div class="entry rtl store-ui">${modalBar(opts)}${header("دادم")}
      <div class="ebody"><div class="ectx"><div class="ectx-lbl" dir="rtl">به</div><div class="ectx-name" dir="rtl">احمد ولی</div></div>
        <div class="fld"><div class="flbl" dir="rtl">مقدار (؋) <span class="req">*</span></div><div class="amtbox"><span class="amtnum">5000</span></div></div>
        <div class="fld"><div class="flbl" dir="rtl">یادداشت</div><div class="notebox" dir="rtl">روغن و برنج</div></div>
        <div class="scene-save-space"></div><div class="savebtn">ذخیره</div>
      </div>
    </div>`;
    return nativeModal(content, opts, screenPerson({ bar: "" }));
  }

  function screenOnboarding(opts = {}) {
    return `<div class="ob-screen rtl store-ui">${bar(opts)}
      <div class="scene-ob-header" dir="rtl">کاتا.</div>
      <div class="ob"><div class="ob-check">${ion("checkmark-circle-outline", 56, app.textEmphasis)}</div>
        <div class="ob-title" dir="rtl">کاتای شما آماده است</div>
        <div class="ob-body" dir="rtl">یک نفر را اضافه کنید و داد و گرفت‌تان را ثبت کنید. کاتا بیلانس را برای‌تان حساب می‌کند.</div>
        <div class="ob-card">${ion("book-outline", 22, app.textSubtle)}<div class="scene-ob-name"><div class="scene-ob-label" dir="rtl">کاتای شما</div><div class="ob-shop" dir="rtl">مارکیت برادران</div></div></div>
      </div><div class="ob-foot"><div class="herobtn">باز کردن کاتای من</div></div>
    </div>`;
  }

  // SearchSheet with the keyboard dismissed and two matching contacts selected.
  // Selected data: Ahmad Wali 15000−2500=12500 (2 gave / 1 received);
  // Ahmad Rahimi 5000−6500=−1500 (2 gave / 2 received). Totals 20000−9000=11000.
  function screenSearch(opts = {}) {
    const rows = [
      ["احمد رحیمی", "دیروز", "−1,500", true, false],
      ["احمد ولی", "2 ساعت پیش", "+12,500", true, true],
      ["محمد احمد", "3 روز پیش", "+3,200", false, false],
      ["نور احمد", "دیروز", null, false, false],
    ];
    const metric = (label, amount, count, color) =>
      `<div class="scene-metric"><div class="scene-metric-row"><span>${label}</span><span>معاملات</span></div><div class="scene-metric-row"><span class="scene-metric-money" style="color:${color}">${money(amount)}</span><span class="num">${count}</span></div></div>`;
    const content = `<div class="scene-search rtl store-ui">${modalBar(opts)}${header("انتخاب مخاطبین")}
      <div class="scene-search-controls"><div class="scene-query">${ion("search-outline", 22, app.textSubtle)}<span dir="rtl">احمد</span>${ion("close-circle", 16, app.textMuted)}</div><div class="scene-filter">${ion("options-outline", 22, app.textDefault)}</div></div>
      <div class="scene-result-summary"><span dir="rtl">4 مشتری مطابق جستجو</span><span dir="rtl">پاک‌کردن همه</span></div>
      <div class="card scene-results-card">${rows.map(([name, when, amount, selected, shared]) => `<div class="prow${selected ? " scene-selected" : ""}"><div class="scene-selection-mark${selected ? " on" : ""}">${selected ? ion("checkmark", 14, app.bg) : ""}</div><div class="pleft"><div class="scene-result-name"><span class="pname" dir="rtl">${name}</span>${shared ? material("verified", 16, app.sharedAccount) : ""}</div><div class="psub" dir="rtl">${when}</div></div><div class="pamt" style="color:${amount?.startsWith("−") ? app.payStrong : app.collectStrong}">${amount ? money(amount) : ion("checkmark", 22, app.textSubtle)}</div></div>`).join(divider)}</div>
      <div class="scene-selection-footer"><div class="scene-selection-panel"><div class="scene-selection-header"><div class="scene-selection-close">${ion("close", 20, app.textEmphasis)}</div><span class="scene-selection-count" dir="rtl">2 انتخاب شده</span><div class="scene-select-all" dir="rtl">انتخاب همه نتایج</div></div>
        <div class="scene-metrics">${metric("مجموع طلب", "20,000", 4, app.collectStrong)}${metric("مجموع قرض", "9,000", 3, app.payStrong)}</div>
        <div class="scene-remaining"><span dir="rtl">طلب باقی‌مانده</span><span class="scene-remaining-amount">${money("11,000")}</span></div>
        <div class="scene-selection-actions"><div class="scene-remove">${ion("trash-outline", 18, app.danger)}<span>برداشتن</span></div></div>
      </div></div>
    </div>`;
    return nativeModal(content, opts, screenHome({ bar: "" }));
  }

  // Genuine personal ReminderEditor state, not a simulated WhatsApp chat.
  // Scheduling alerts the kaata user; it does not send messages to a customer.
  function screenReminder(opts = {}) {
    const choices = (labels, selected) =>
      labels
        .map(
          (label, i) =>
            `<div class="scene-reminder-choice${i === selected ? " chosen" : ""}">${label}</div>`,
        )
        .join("");
    return `<div class="scene-reminder rtl store-ui">${bar(opts)}${header("یادآوری‌ها")}
      <div class="scene-reminder-body"><p class="scene-reminder-hint" dir="rtl">فقط برای شما در این تلفن است. چیزی به مشتری فرستاده نمی‌شود.</p><div class="scene-reminder-name" dir="rtl">احمد ولی</div>
        <div class="scene-reminder-editor"><div class="scene-reminder-choices">${choices(["یک‌بار", "هر روز", "هر هفته", "ماهانه"], 2)}</div>
          <div class="scene-weekday"><div class="scene-reminder-caption" dir="rtl">روز هفته</div><div class="scene-reminder-caption" dir="rtl">هر روزی را که می‌خواهید انتخاب کنید.</div><div class="scene-reminder-choices">${choices(["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"], 0)}</div></div>
          <div class="scene-reminder-time" dir="rtl"><div class="scene-reminder-caption">وقت</div><div class="scene-reminder-clock"><bdi>4:00</bdi> ب.ظ</div></div>
          <div class="scene-reminder-footer"><div class="savebtn">ذخیره</div><div class="scene-secondary">لغو</div></div>
        </div><div class="scene-secondary">همه</div>
      </div>
    </div>`;
  }

  return { screenHome, screenPerson, screenEntry, screenOnboarding, screenSearch, screenReminder };
}

// App-only overrides. Append after the shared legacy app CSS so old marketing
// palettes cannot leak into these current neutral screens.
const SCENE_CSS = `
.store-ui{background:#fff;}
.store-ui .num{direction:ltr;unicode-bidi:isolate;}
.store-ui .total-lbl,.store-ui .pd-chip,.store-ui .ectx-lbl,.store-ui .abtn{letter-spacing:0;}
.store-ui .pname,.store-ui .psub,.store-ui .enote{line-height:1.65;}
.store-ui .shop{line-height:1.6;overflow:hidden;text-overflow:ellipsis;}
.store-ui .hdr-title{min-width:0;max-width:75%;}
.store-ui .hdr-title .glyph{flex:none;}
.store-ui .scene-header{flex-direction:row-reverse;}
.store-ui .pnav,.store-ui .pnav-actions,.store-ui .pd-namerow,.store-ui .pd-overview,.store-ui .pd-bal,.store-ui .erow,.store-ui .etop,.store-ui .eamt,.store-ui .emeta,.store-ui .psearch,.store-ui .psearch-box{flex-direction:row-reverse;}
.store-ui .navwa{margin-right:0;margin-left:${d(8)};}
.store-ui .scene-identity{display:flex;flex-direction:row-reverse;align-items:center;justify-content:space-between;gap:${d(10)};}
.store-ui .scene-group{padding:${d(3)} ${d(8)};font-size:${d(11)};line-height:1.6;border:1px solid #E2E2E2;border-radius:${d(8)};background:#F7F7F7;color:#616161;}
.store-ui .pd-balance{text-align:right;}
.store-ui .pd-chip{line-height:1.7;}
.store-ui .pd-flows{flex:0 1 auto;max-width:50%;gap:${d(6)};}
.store-ui .flow{display:flex;flex-direction:row-reverse;align-items:baseline;justify-content:space-between;gap:${d(10)};}
.store-ui .flow-lbl{font-size:${d(12)};line-height:1.7;white-space:nowrap;}
.store-ui .flow-amt{font-size:${d(15)};line-height:1.4;}
.store-ui .etile{margin-right:0;margin-left:${d(12)};}
.store-ui .pdock-row{direction:ltr;}
.store-ui .pdock .abtn{line-height:${d(20)};box-shadow:0 ${d(3)} ${d(8)} rgba(0,0,0,.10);}
.store-device.ios .store-ui .pdock .abtn{line-height:${d(24)};}
.store-ui .enote{text-align:right;}
.store-ui .ectx,.store-ui .flbl{text-align:right;}
.store-ui .notebox{justify-content:flex-start;}
.store-ui .scene-save-space{height:${d(24)};}
.store-ui .scene-ob-header{width:100%;max-width:${d(480)};min-height:${d(60)};margin:0 auto;padding:${d(16)} ${d(24)};font-size:${d(16)};font-weight:600;text-align:right;}
.store-ui .ob{top:calc(var(--sbar) + ${d(60)});left:50%;right:auto;transform:translateX(-50%);width:100%;max-width:${d(480)};bottom:${di(92)};padding:${d(24)};text-align:center;}
.store-ui .ob-check{align-self:center;background:none;border:0;width:${d(56)};height:${d(56)};margin-bottom:${d(28)};}
.store-ui .ob-title{font-size:${d(28)};line-height:1.6;color:#171717;font-weight:600;}
.store-ui .ob-body{font-size:${d(14)};line-height:1.8;color:#616161;margin-top:${d(8)};}
.store-ui .ob-card{flex-direction:row-reverse;text-align:right;margin-top:${d(28)};background:#F7F7F7;}
.store-ui .scene-ob-name{flex:1;min-width:0;}
.store-ui .scene-ob-label{font-size:${d(12)};color:#6B6B6B;margin-bottom:${d(2)};}
.store-ui .ob-foot{left:50%;right:auto;transform:translateX(-50%);width:100%;max-width:${d(480)};padding:${d(16)} ${d(24)} ${di(24)};}
.store-ui .herobtn{box-shadow:none;}
.scene-search,.scene-reminder{position:absolute;inset:0;}
.scene-native-modal{position:absolute;inset:0;background:#000;overflow:hidden;}
.scene-modal-underlay{position:absolute;inset:${d(48)} 0 0;transform:scale(.94);transform-origin:top center;border-radius:${d(12)};overflow:hidden;}
.scene-modal-dim{position:absolute;inset:0;background:rgba(0,0,0,.3);}
.scene-modal-status{position:absolute;top:0;left:0;right:0;color:#fff;}
.scene-modal-status .sbar{color:#fff!important;}
.scene-modal-card{position:absolute;top:${d(68)};left:0;right:0;bottom:0;background:#fff;border-radius:${d(12)} ${d(12)} 0 0;overflow:hidden;}
.scene-search-controls{display:flex;flex-direction:row-reverse;align-items:center;gap:${d(8)};padding:${d(12)} ${d(16)} ${d(8)};}
.scene-query{display:flex;flex:1;min-width:0;align-items:center;flex-direction:row-reverse;gap:${d(8)};padding:0 ${d(12)};min-height:${d(48)};border:1px solid #E2E2E2;border-radius:${d(12)};font-size:${d(14)};}
.scene-query>span:not(.glyph){flex:1;min-width:0;text-align:right;}
.scene-filter{width:${d(44)};height:${d(44)};display:flex;align-items:center;justify-content:center;border:1px solid #E2E2E2;border-radius:${d(12)};flex:none;}
.scene-result-summary{display:flex;flex-direction:row-reverse;align-items:center;justify-content:space-between;gap:${d(12)};min-height:${d(44)};padding:0 ${d(16)} ${d(8)};font-size:${d(13)};color:#616161;}
.scene-result-summary>span:last-child{color:#292929;}
.scene-results-card{margin-top:0;}
.scene-search .scene-selected{background:#EFEFEF;}
.scene-selection-mark{width:${d(22)};height:${d(22)};border:1.5px solid #6B6B6B;border-radius:50%;margin-left:${d(12)};display:flex;align-items:center;justify-content:center;flex:none;background:#fff;}
.scene-selection-mark.on{border-color:#000;background:#000;}
.scene-result-name{display:flex;flex-direction:row-reverse;gap:${d(5)};align-items:center;}
.scene-search .pamt .num{color:inherit;}
.scene-selection-footer{position:absolute;bottom:${di(8)};left:${d(16)};right:${d(16)};background:transparent;}
.scene-selection-panel{background:#fff;border:1px solid #E2E2E2;border-radius:${d(16)};padding:${d(8)};box-shadow:0 ${d(6)} ${d(20)} rgba(0,0,0,.10);}
.scene-selection-header{display:flex;flex-direction:row-reverse;align-items:center;gap:${d(8)};margin-bottom:${d(8)};}
.scene-selection-close{width:${d(44)};height:${d(44)};border-radius:50%;background:#F7F7F7;display:flex;align-items:center;justify-content:center;flex:none;}
.scene-selection-count{flex:1;font-size:${d(15)};font-weight:600;text-align:right;}
.scene-select-all{min-height:${d(44)};display:flex;align-items:center;justify-content:center;border:1px solid #E2E2E2;border-radius:${d(12)};padding:0 ${d(12)};font-size:${d(13)};}
.scene-metrics{display:flex;flex-direction:row-reverse;gap:${d(8)};}
.scene-metric{flex:1;min-width:0;background:#F7F7F7;padding:${d(8)};border-radius:${d(12)};}
.scene-metric-row{display:flex;flex-direction:row-reverse;align-items:baseline;justify-content:space-between;gap:${d(8)};font-size:${d(13)};color:#616161;line-height:1.7;}
.scene-metric-row+ .scene-metric-row{margin-top:${d(4)};}
.scene-metric-row>.num{font-size:${d(15)};}
.scene-metric-money{display:flex;flex-direction:row-reverse;align-items:baseline;gap:${d(4)};}
.scene-metric-money .num{font-size:${d(15)};font-weight:600;}
.scene-metric-money .afn{font-size:${d(11)};}
.scene-remaining{display:flex;flex-direction:row-reverse;align-items:baseline;justify-content:space-between;gap:${d(8)};padding:${d(12)} ${d(8)};font-size:${d(15)};font-weight:600;}
.scene-remaining-amount{display:flex;flex-direction:row-reverse;align-items:baseline;gap:${d(4)};}
.scene-remaining-amount .num{font-size:${d(17)};font-weight:700;}
.scene-remaining-amount .afn{font-size:${d(11)};}
.scene-selection-actions{border-top:1px solid #E2E2E2;padding-top:${d(8)};}
.scene-remove{display:flex;flex-direction:row-reverse;justify-content:center;align-items:center;gap:${d(8)};min-height:${d(44)};border:1px solid #E2E2E2;border-radius:${d(12)};font-size:${d(13)};color:#DC2626;}
.scene-reminder-body{padding:${d(20)};}
.scene-reminder-hint{font-size:${d(13)};line-height:1.7;color:#616161;text-align:right;}
.scene-reminder-name{font-size:${d(20)};font-weight:600;margin-top:${d(16)};text-align:right;}
.scene-reminder-editor{padding:${d(12)} 0;margin-top:${d(16)};margin-bottom:${d(16)};}
.scene-reminder-choices{display:flex;flex-direction:row-reverse;flex-wrap:wrap;gap:${d(10)};}
.scene-reminder-choice{min-height:${d(44)};display:flex;justify-content:center;align-items:center;padding:${d(10)} ${d(12)};border:1px solid #E2E2E2;border-radius:${d(12)};font-size:${d(13)};}
.scene-reminder-choice.chosen{border-color:#000;background:#F7F7F7;}
.scene-weekday{margin-top:${d(20)};display:flex;flex-direction:column;gap:${d(10)};}
.scene-reminder-caption{font-size:${d(12)};line-height:1.6;color:#616161;text-align:right;}
.scene-reminder-time{padding:${d(16)} 0;border-bottom:1px solid #EFEFEF;}
.scene-reminder-clock{font-size:${d(13)};margin-top:${d(6)};text-align:right;}
.scene-reminder-footer{display:flex;flex-direction:column;gap:${d(12)};margin-top:${d(24)};}
.scene-secondary{min-height:${d(44)};display:flex;justify-content:center;align-items:center;border:1px solid #E2E2E2;border-radius:${d(8)};font-size:${d(15)};font-weight:600;}
`;

module.exports = { createScenes, SCENE_CSS };
