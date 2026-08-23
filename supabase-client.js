/* نظام إدارة عقود بلدي - تكامل Supabase لجيت هب بيجز */
(function () {
  'use strict';

  const CONFIG = Object.freeze({
    url: 'https://pthfrwsmdjcbaholfext.supabase.co',
    publishableKey: 'sb_publishable_Ft5krX1WBzmLE_Lthqj7Pw_--4Kn7_K'
  });
  const CONTRACTS_TABLE = 'contracts';
  const FILES_BUCKET = 'contract-files';
  const LOCAL_CONTRACTS_KEY = 'baladyWasteContractsV3';
  const INTERNAL_KEYS = new Set(['__cloudSynced', '__storagePath']);

  let client = null;
  let session = null;
  let currentProfile = null;
  let cloudApplying = false;
  let syncTimer = null;
  let realtimeChannel = null;
  let legacyAttachPdf = null;
  let legacyGetPdfRecord = null;
  let legacyDeletePdfBlob = null;
  let legacyOpenSavedPdf = null;
  let legacyDownloadSavedPdf = null;
  let legacyOpenContractAttachment = null;

  function notify(message, type) {
    const loginOverlay = document.getElementById('loginOverlay');
    const loginError = document.getElementById('loginError');
    if (loginOverlay && loginOverlay.style.display !== 'none' && loginError) {
      loginError.textContent = String(message || '');
      loginError.style.display = 'block';
      loginError.classList.add('show');
      loginError.style.color = type === 'success' ? '#047857' : '#b91c1c';
      loginError.style.background = type === 'success' ? '#ecfdf5' : '#fef2f2';
      loginError.style.border = '1px solid ' + (type === 'success' ? '#86efac' : '#fecaca');
      return;
    }
    if (typeof window.showAlert === 'function') window.showAlert(message, type || 'info');
    else window.alert(message);
  }

  function normalizeContractNumber(value) {
    return String(value || '').trim().replace(/[٠-٩]/g, function (d) {
      return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    }).replace(/[۰-۹]/g, function (d) {
      return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
    });
  }

  function toIsoDate(value) {
    if (!value) return null;
    const text = String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }

  function cleanContractData(contract) {
    const out = {};
    Object.keys(contract || {}).forEach(function (key) {
      if (!INTERNAL_KEYS.has(key) && contract[key] !== undefined && typeof contract[key] !== 'function') out[key] = contract[key];
    });
    return out;
  }

  function contractToRow(contract) {
    const value = cleanContractData(contract);
    const number = normalizeContractNumber(value.contractNumber);
    return {
      contract_number: number,
      customer_name: value.customerName || null,
      commercial_registry: value.commercialRegistry || null,
      commercial_act_license: value.commercialActLicense || null,
      isic_classification: value.isicClassification || null,
      total_area: value.totalArea === '' || value.totalArea == null ? null : Number(value.totalArea),
      district: value.district || null,
      location: value.location || null,
      municipality: value.municipality || null,
      bin_size: value.binSize || null,
      quantity: value.quantity === '' || value.quantity == null ? 1 : Number(value.quantity),
      price_per_unit: value.pricePerUnit === '' || value.pricePerUnit == null ? null : Number(value.pricePerUnit),
      old_start_date: toIsoDate(value.oldStartDate),
      old_end_date: toIsoDate(value.oldEndDate),
      new_start_date: toIsoDate(value.newStartDate),
      new_end_date: toIsoDate(value.newEndDate),
      coordinates: value.coordinates || null,
      map_url: value.mapUrl || null,
      file_name: value.fileName || null,
      has_pdf: Boolean(value.hasPdf),
      storage_path: value.storagePath || value.__storagePath || null,
      data: value
    };
  }

  function rowToContract(row) {
    const data = Object.assign({}, row.data || {});
    data.contractNumber = row.contract_number || data.contractNumber || '';
    data.customerName = row.customer_name != null ? row.customer_name : (data.customerName || '');
    data.commercialRegistry = row.commercial_registry != null ? row.commercial_registry : (data.commercialRegistry || '');
    data.commercialActLicense = row.commercial_act_license != null ? row.commercial_act_license : (data.commercialActLicense || '');
    data.isicClassification = row.isic_classification != null ? row.isic_classification : (data.isicClassification || '');
    data.totalArea = row.total_area != null ? row.total_area : (data.totalArea || '');
    data.district = row.district != null ? row.district : (data.district || '');
    data.location = row.location != null ? row.location : (data.location || '');
    data.municipality = row.municipality != null ? row.municipality : (data.municipality || '');
    data.binSize = row.bin_size != null ? row.bin_size : (data.binSize || '');
    data.quantity = row.quantity != null ? row.quantity : (data.quantity || 1);
    data.pricePerUnit = row.price_per_unit != null ? Number(row.price_per_unit) : (data.pricePerUnit || 0);
    data.oldStartDate = row.old_start_date || data.oldStartDate || '';
    data.oldEndDate = row.old_end_date || data.oldEndDate || '';
    data.newStartDate = row.new_start_date || data.newStartDate || '';
    data.newEndDate = row.new_end_date || data.newEndDate || '';
    data.coordinates = row.coordinates != null ? row.coordinates : (data.coordinates || '');
    data.mapUrl = row.map_url != null ? row.map_url : (data.mapUrl || '');
    data.fileName = row.file_name || data.fileName || '';
    data.hasPdf = Boolean(row.has_pdf || data.hasPdf);
    data.storagePath = row.storage_path || data.storagePath || '';
    data.updatedAt = new Date(row.updated_at || Date.now()).getTime();
    data.__cloudSynced = true;
    return data;
  }

  function persistLocalContracts() {
    try { localStorage.setItem(LOCAL_CONTRACTS_KEY, JSON.stringify(window.allContracts || [])); } catch (e) { console.warn(e); }
  }

  function isCurrentUserAdmin() {
    return Boolean(currentProfile && currentProfile.is_admin);
  }

  function requireSession() {
    if (!session || !session.user) {
      notify('سجّل الدخول أولاً للوصول إلى البيانات المشتركة.', 'error');
      return false;
    }
    return true;
  }

  function requireAdmin() {
    if (!isCurrentUserAdmin()) {
      notify('هذه العملية متاحة للمدير فقط. يملك المستخدمون صلاحية إضافة العقود وملفات PDF فقط.', 'error');
      return false;
    }
    return true;
  }

  function renderAccessState() {
    document.body.classList.toggle('is-admin', isCurrentUserAdmin());
    document.body.classList.toggle('is-contributor', Boolean(session && !isCurrentUserAdmin()));
    const syncButton = document.getElementById('btnForceSync');
    if (syncButton) {
      syncButton.textContent = isCurrentUserAdmin() ? '☁️ مزامنة' : '';
      syncButton.classList.toggle('show', isCurrentUserAdmin());
    }
    const userButton = document.getElementById('btnUsersMgmt');
    if (userButton) {
      userButton.textContent = isCurrentUserAdmin() ? '🔑 إدارة المستخدمين' : '';
      userButton.classList.toggle('show', isCurrentUserAdmin());
    }
    const clearButton = Array.from(document.querySelectorAll('button')).find(function (button) {
      return /مسح الكل/.test(button.textContent || '');
    });
    if (clearButton) clearButton.style.display = isCurrentUserAdmin() ? '' : 'none';
  }

  function showAppUnlocked() {
    const overlay = document.getElementById('loginOverlay');
    const app = document.getElementById('appRoot');
    if (overlay) { overlay.classList.remove('show'); overlay.style.display = 'none'; }
    if (app) { app.classList.add('unlocked'); app.style.display = 'block'; }
    renderAccessState();
  }

  function showLoginScreen() {
    const overlay = document.getElementById('loginOverlay');
    const app = document.getElementById('appRoot');
    if (overlay) { overlay.classList.add('show'); overlay.style.display = 'flex'; }
    if (app) { app.classList.remove('unlocked'); app.style.display = 'none'; }
    const error = document.getElementById('loginError');
    if (error) error.classList.remove('show');
    renderAccessState();
  }

  async function loadProfile() {
    if (!session || !session.user) { currentProfile = null; return null; }
    const result = await client.from('profiles').select('id,email,is_admin').eq('id', session.user.id).maybeSingle();
    if (result.error) {
      console.warn('Profile load failed:', result.error.message);
      currentProfile = { id: session.user.id, email: session.user.email, is_admin: false };
    } else {
      currentProfile = result.data || { id: session.user.id, email: session.user.email, is_admin: false };
    }
    return currentProfile;
  }

  async function loadCloudContracts(options) {
    if (!requireSession()) return;
    const keepPage = Boolean(options && options.keepPage);
    const page = window.currentPage || 1;
    const result = await client.from(CONTRACTS_TABLE).select('*').order('updated_at', { ascending: false });
    if (result.error) {
      notify('تعذر تحميل العقود من الخادم: ' + result.error.message, 'error');
      return;
    }
    cloudApplying = true;
    try {
      const cloudList = (result.data || []).map(rowToContract);
      const pending = (window.allContracts || []).filter(function (contract) { return !contract.__cloudSynced; });
      const byNumber = new Map();
      cloudList.forEach(function (contract) { byNumber.set(String(contract.contractNumber), contract); });
      pending.forEach(function (contract) {
        if (!byNumber.has(String(contract.contractNumber))) byNumber.set(String(contract.contractNumber), contract);
      });
      window.allContracts = Array.from(byNumber.values());
      if (typeof window.sortContractsByDate === 'function') window.allContracts = window.sortContractsByDate(window.allContracts);
      persistLocalContracts();
      if (typeof window.applyFilters === 'function') window.applyFilters(true);
      else if (typeof window.renderTable === 'function') window.renderTable(window.allContracts);
      if (keepPage && typeof window.currentPage !== 'undefined') window.currentPage = page;
      if (typeof window.renderTable === 'function' && window.filteredContracts) window.renderTable(window.filteredContracts);
    } finally {
      setTimeout(function () { cloudApplying = false; }, 250);
    }
  }

  async function syncContractsNow() {
    if (!requireSession() || cloudApplying) return { ok: false, count: 0 };
    const contracts = Array.isArray(window.allContracts) ? window.allContracts : [];
    const candidates = isCurrentUserAdmin() ? contracts : contracts.filter(function (contract) { return !contract.__cloudSynced; });
    const valid = candidates.filter(function (contract) { return normalizeContractNumber(contract.contractNumber); });
    if (!valid.length) return { ok: true, count: 0 };
    const rows = valid.map(contractToRow);
    const result = await client.from(CONTRACTS_TABLE).upsert(rows, { onConflict: 'contract_number' }).select('contract_number');
    if (result.error) {
      console.warn('Cloud sync failed:', result.error.message);
      if (!isCurrentUserAdmin()) notify('تم حفظ التغييرات محلياً فقط؛ المستخدمون يستطيعون إضافة عقود جديدة ولا يملكون تعديل العقود القائمة.', 'info');
      else notify('تعذر حفظ التغييرات في الخادم: ' + result.error.message, 'error');
      return { ok: false, count: 0, error: result.error.message };
    }
    const saved = new Set((result.data || []).map(function (row) { return String(row.contract_number); }));
    contracts.forEach(function (contract) {
      if (saved.has(String(contract.contractNumber))) contract.__cloudSynced = true;
    });
    persistLocalContracts();
    return { ok: true, count: saved.size };
  }

  async function syncLocalPdfs() {
    if (!requireAdmin() || typeof legacyGetPdfRecord !== 'function') return { ok: true, count: 0 };
    const contracts = Array.isArray(window.allContracts) ? window.allContracts : [];
    let uploadedCount = 0;
    for (const contract of contracts) {
      const number = normalizeContractNumber(contract && contract.contractNumber);
      if (!number || contract.storagePath) continue;
      try {
        const local = await legacyGetPdfRecord(number);
        if (!local || !local.blob || !local.blob.size) continue;
        const file = new File([local.blob], local.fileName || (number + '.pdf'), { type: 'application/pdf' });
        const uploaded = await uploadPdf(number, file);
        if (uploaded) {
          contract.storagePath = uploaded.path;
          contract.fileName = uploaded.fileName;
          contract.hasPdf = true;
          contract.__cloudSynced = false;
          uploadedCount += 1;
        }
      } catch (error) { console.warn('Local PDF migration failed', number, error); }
    }
    if (uploadedCount) persistLocalContracts();
    return { ok: true, count: uploadedCount };
  }

  async function forceSyncLocalContracts() {
    if (!requireAdmin()) return;
    const localCount = Array.isArray(window.allContracts) ? window.allContracts.filter(function (contract) { return normalizeContractNumber(contract.contractNumber); }).length : 0;
    if (!localCount) {
      notify('لا توجد عقود محلية قابلة للمزامنة على هذا الجهاز.', 'info');
      return;
    }
    notify('جاري رفع العقود وملفات PDF إلى Supabase...', 'info');
    const pdfResult = await syncLocalPdfs();
    const result = await syncContractsNow();
    if (result && result.ok) {
      await loadCloudContracts({ keepPage: true });
      notify('تمت مزامنة ' + result.count + ' عقد و' + pdfResult.count + ' ملف PDF بنجاح. افتح الجوال الآن.', 'success');
    }
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncContractsNow().catch(function (error) { console.warn(error); }); }, 700);
  }

  function installRealtime() {
    if (!client || !session) return;
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = client.channel('balady-contracts-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: CONTRACTS_TABLE }, function () {
        if (!cloudApplying) loadCloudContracts({ keepPage: true }).catch(function (error) { console.warn(error); });
      })
      .subscribe();
  }

  async function uploadPdf(contractNumber, file) {
    if (!requireSession()) return null;
    if (!file || file.type !== 'application/pdf') {
      notify('يُسمح برفع ملفات PDF فقط.', 'error');
      return null;
    }
    if (file.size > 25 * 1024 * 1024) {
      notify('حجم ملف PDF يتجاوز الحد المسموح (25 ميجابايت).', 'error');
      return null;
    }
    // مسار ASCII فقط؛ بعض مسارات Storage ترفض المحارف العربية أو المفاتيح غير المرمزة.
    const originalName = String(file.name || 'contract.pdf');
    const safeName = 'contract-' + Date.now() + '.pdf';
    const safeNumber = encodeURIComponent(normalizeContractNumber(contractNumber) || 'unassigned');
    const path = session.user.id + '/' + safeNumber + '/' + safeName;
    const result = await client.storage.from(FILES_BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: false });
    if (result.error) {
      notify('تعذر رفع PDF المشترك: ' + result.error.message, 'error');
      return null;
    }
    return { path: result.data.path, fileName: originalName };
  }

  async function getSharedPdfRecord(contractNumber) {
    const number = normalizeContractNumber(contractNumber);
    const contract = (window.allContracts || []).find(function (item) { return String(item.contractNumber) === number; });
    const path = contract && (contract.storagePath || contract.__storagePath);
    if (!path || !requireSession()) return null;
    const result = await client.storage.from(FILES_BUCKET).download(path);
    if (result.error) {
      console.warn('Shared PDF download failed:', result.error.message);
      return null;
    }
    return { contractNumber: number, blob: result.data, fileName: contract.fileName || (number + '.pdf'), saved: true, shared: true };
  }

  async function deleteSharedPdf(contractNumber) {
    if (!requireAdmin()) return false;
    const number = normalizeContractNumber(contractNumber);
    const contract = (window.allContracts || []).find(function (item) { return String(item.contractNumber) === number; });
    const path = contract && (contract.storagePath || contract.__storagePath);
    if (!path) return true;
    const result = await client.storage.from(FILES_BUCKET).remove([path]);
    if (result.error) {
      notify('تعذر حذف PDF المشترك: ' + result.error.message, 'error');
      return false;
    }
    contract.storagePath = '';
    contract.hasPdf = false;
    scheduleSync();
    return true;
  }

  async function attemptLogin(event) {
    if (event) event.preventDefault();
    const email = String((document.getElementById('loginEmail') || {}).value || '').trim();
    const password = String((document.getElementById('loginPassword') || {}).value || '');
    const errorBox = document.getElementById('loginError');
    if (!email || !password) return false;
    const result = await client.auth.signInWithPassword({ email: email, password: password });
    if (result.error) {
      if (errorBox) { errorBox.textContent = 'تعذر تسجيل الدخول: ' + result.error.message; errorBox.classList.add('show'); }
      return false;
    }
    if (errorBox) errorBox.classList.remove('show');
    return false;
  }

  async function registerAccount() {
    const email = String((document.getElementById('loginEmail') || {}).value || '').trim();
    const password = String((document.getElementById('loginPassword') || {}).value || '');
    if (!email || password.length < 8) {
      notify('أدخل بريدك الإلكتروني وكلمة مرور لا تقل عن 8 أحرف لإنشاء الحساب.', 'error');
      return;
    }
    const result = await client.auth.signUp({ email: email, password: password });
    if (result.error) {
      notify('تعذر إنشاء الحساب: ' + result.error.message, 'error');
      return;
    }
    notify('تم إنشاء الحساب. إن طُلب منك تأكيد البريد الإلكتروني، افتح الرسالة ثم سجّل الدخول.', 'success');
  }

  async function logoutApp() {
    if (!window.confirm('هل تريد تسجيل الخروج؟')) return;
    await client.auth.signOut();
  }

  async function deleteContract(contractNumber) {
    if (!requireAdmin()) return;
    if (!window.confirm('هل أنت متأكد من حذف العقد وملفه المشترك نهائياً؟')) return;
    const number = normalizeContractNumber(contractNumber);
    await deleteSharedPdf(number);
    const result = await client.from(CONTRACTS_TABLE).delete().eq('contract_number', number);
    if (result.error) { notify('تعذر حذف العقد: ' + result.error.message, 'error'); return; }
    window.allContracts = (window.allContracts || []).filter(function (contract) { return String(contract.contractNumber) !== number; });
    persistLocalContracts();
    if (typeof window.applyFilters === 'function') window.applyFilters();
    notify('تم حذف العقد.', 'success');
  }

  async function clearAllData() {
    if (!requireAdmin()) return;
    if (!window.confirm('سيتم حذف كل العقود والملفات المشتركة نهائياً. هل تريد المتابعة؟')) return;
    const list = window.allContracts || [];
    const paths = list.map(function (contract) { return contract.storagePath; }).filter(Boolean);
    if (paths.length) await client.storage.from(FILES_BUCKET).remove(paths);
    const result = await client.from(CONTRACTS_TABLE).delete().not('contract_number', 'is', null);
    if (result.error) { notify('تعذر مسح العقود: ' + result.error.message, 'error'); return; }
    window.allContracts = [];
    persistLocalContracts();
    if (typeof window.renderTable === 'function') window.renderTable([]);
    notify('تم مسح العقود والملفات المشتركة.', 'success');
  }

  function openUsersModal() {
    if (!requireAdmin()) return;
    const modal = document.getElementById('usersModal');
    const content = modal && modal.querySelector('.modal-content');
    if (!content) return;
    content.innerHTML = '<span class="modal-close" onclick="closeUsersModal()">&times;</span>' +
      '<div style="font-weight:800;color:#134e4a;font-size:1.15em;margin-bottom:8px;">صلاحيات النظام</div>' +
      '<p style="color:#475569;line-height:1.8;">أنت مسجل كمدير. ينشئ المستخدمون حساباتهم من شاشة الدخول، ثم يحصلون على قراءة العقود ورفع ملفات PDF وإضافة عقود جديدة فقط. التعديل والحذف ومسح البيانات محفوظة لحساب المدير.</p>' +
      '<p style="color:#64748b;font-size:.85em;">لتعطيل حساب أو إعادة تعيين كلمة مروره استخدم قسم Authentication في لوحة Supabase.</p>' +
      '<div class="buttons-row" style="margin-top:14px;justify-content:center;"><button type="button" class="btn-primary" onclick="closeUsersModal()">إغلاق</button></div>';
    modal.style.display = 'block';
  }

  function closeUsersModal() {
    const modal = document.getElementById('usersModal');
    if (modal) modal.style.display = 'none';
  }

  function installGuards() {
    document.addEventListener('click', function (event) {
      if (isCurrentUserAdmin()) return;
      const action = event.target && event.target.closest ? event.target.closest('[onclick]') : null;
      const code = action && action.getAttribute('onclick') || '';
      if (/(deleteContract|clearAllData|openEditContract|clearContractImage|unlockPriceEdit|unlockNewDatesEdit|unlockContractNumberEdit|toggleMgmtList|confirmMgmtDelete)/.test(code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        notify('هذه العملية متاحة للمدير فقط.', 'error');
      }
    }, true);
  }

  function captureLegacyFunctions() {
    legacyAttachPdf = window.attachAndSavePdf;
    legacyGetPdfRecord = window.getPdfRecord;
    legacyDeletePdfBlob = window.deletePdfBlob;
    legacyOpenSavedPdf = window.openSavedPdf;
    legacyDownloadSavedPdf = window.downloadSavedPdf;
    legacyOpenContractAttachment = window.openContractAttachment;

    if (typeof legacyAttachPdf === 'function') {
      window.attachAndSavePdf = async function (contractNumber, file) {
        if (!requireSession()) return null;
        const localRecord = await legacyAttachPdf(contractNumber, file);
        const uploaded = await uploadPdf(contractNumber, file);
        if (!uploaded) return localRecord;
        const number = normalizeContractNumber(contractNumber);
        const contract = (window.allContracts || []).find(function (item) { return String(item.contractNumber) === number; });
        if (contract) {
          contract.storagePath = uploaded.path;
          contract.fileName = uploaded.fileName;
          contract.hasPdf = true;
          contract.__cloudSynced = false;
          persistLocalContracts();
          scheduleSync();
        }
        notify('تم رفع PDF إلى المساحة المشتركة بنجاح.', 'success');
        return Object.assign({}, localRecord || {}, { storagePath: uploaded.path, shared: true });
      };
    }

    if (typeof legacyGetPdfRecord === 'function') {
      window.getPdfRecord = async function (contractNumber) {
        const shared = await getSharedPdfRecord(contractNumber);
        if (shared) return shared;
        return legacyGetPdfRecord(contractNumber);
      };
    }

    if (typeof legacyDeletePdfBlob === 'function') {
      window.deletePdfBlob = async function (contractNumber) {
        const removed = await deleteSharedPdf(contractNumber);
        if (!removed) return false;
        return legacyDeletePdfBlob(contractNumber);
      };
    }

    // وظائف الصفحة القديمة تبحث في IndexedDB فقط؛ نضع السجل السحابي أولاً.
    window.openSavedPdf = async function (contractNumber) {
      const shared = await getSharedPdfRecord(contractNumber);
      if (shared && shared.blob) {
        return displayPdfBlob(shared.blob, shared.fileName, null);
      }
      if (typeof legacyOpenSavedPdf === 'function') return legacyOpenSavedPdf(contractNumber);
      notify('لا يوجد PDF محفوظ لهذا العقد.', 'info');
      return false;
    };

    window.downloadSavedPdf = async function (contractNumber) {
      const shared = await getSharedPdfRecord(contractNumber);
      if (shared && shared.blob) {
        const url = URL.createObjectURL(shared.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = shared.fileName || (normalizeContractNumber(contractNumber) + '.pdf');
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 2000);
        return true;
      }
      if (typeof legacyDownloadSavedPdf === 'function') return legacyDownloadSavedPdf(contractNumber);
      notify('لا يوجد PDF محفوظ لهذا العقد.', 'info');
      return false;
    };

    window.openContractAttachment = async function (contractNumber) {
      const shared = await getSharedPdfRecord(contractNumber);
      if (shared && shared.blob) return displayPdfBlob(shared.blob, shared.fileName, null);
      if (typeof legacyOpenContractAttachment === 'function') return legacyOpenContractAttachment(contractNumber);
      notify('لا يوجد مرفق محفوظ لهذا العقد.', 'info');
      return false;
    };
  }

  function installOverrides() {
    window.isCurrentUserAdmin = isCurrentUserAdmin;
    window.isLoggedIn = function () { return Boolean(session); };
    window.getSessionEmail = function () { return session && session.user ? session.user.email || '' : ''; };
    window.attemptLogin = attemptLogin;
    window.registerAccount = registerAccount;
    window.logoutApp = logoutApp;
    window.deleteContract = deleteContract;
    window.clearAllData = clearAllData;
    window.openUsersModal = openUsersModal;
    window.closeUsersModal = closeUsersModal;
    window.showAppUnlocked = showAppUnlocked;
    window.showLoginScreen = showLoginScreen;
    window.saveToLocalStorage = function () {
      if (!cloudApplying) {
        (window.allContracts || []).forEach(function (contract) {
          if (contract && !contract.updatedAt) contract.updatedAt = Date.now();
        });
      }
      persistLocalContracts();
      if (!cloudApplying) scheduleSync();
    };
    window.saveContractToCloud = function () { scheduleSync(); };
    window.syncAllContractsToCloud = function () { scheduleSync(); };
    window.deleteContractFromCloud = function (contractNumber) { return deleteContract(contractNumber); };
    window.clearAllContractsFromCloud = clearAllData;
    window.startCloudSync = function () { return loadCloudContracts({ keepPage: true }); };
    window.forceSyncLocalContracts = forceSyncLocalContracts;
    window.askPassword = async function () {
      return isCurrentUserAdmin() ? '__AUTH_ADMIN__' : null;
    };
  }

  async function onSignedIn() {
    await loadProfile();
    showAppUnlocked();
    // ارفع البيانات والمرفقات المحلية قبل استبدالها بنتيجة السحابة، حتى لا تختفي عقود الكمبيوتر.
    if (isCurrentUserAdmin() && Array.isArray(window.allContracts) && window.allContracts.length) {
      await syncLocalPdfs();
      await syncContractsNow();
    }
    await loadCloudContracts();
    installRealtime();
    if (isCurrentUserAdmin()) scheduleSync();
  }

  async function bootstrap() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      notify('تعذر تحميل مكوّن الاتصال بالخادم. تحقق من اتصال الإنترنت.', 'error');
      return;
    }
    client = window.supabase.createClient(CONFIG.url, CONFIG.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    captureLegacyFunctions();
    installOverrides();
    installGuards();

    const createButton = document.getElementById('registerAccountButton');
    if (createButton) createButton.addEventListener('click', registerAccount);

    const current = await client.auth.getSession();
    session = current.data.session;
    if (session) await onSignedIn();
    else showLoginScreen();

    client.auth.onAuthStateChange(function (event, nextSession) {
      session = nextSession;
      if (event === 'SIGNED_OUT' || !nextSession) {
        currentProfile = null;
        if (realtimeChannel) client.removeChannel(realtimeChannel);
        realtimeChannel = null;
        showLoginScreen();
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setTimeout(function () { onSignedIn().catch(function (error) { console.warn(error); }); }, 0);
      }
    });
  }

  window.addEventListener('load', function () { bootstrap().catch(function (error) { console.error(error); notify('تعذر بدء الاتصال بالخادم.', 'error'); }); });
}());
