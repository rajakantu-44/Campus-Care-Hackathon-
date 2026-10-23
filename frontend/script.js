// CampusCare's entire browser-side behavior lives here so the HTML/CSS can be redesigned freely.
const API_BASE = "http://127.0.0.1:5000/api";
const BACKEND_BASE = API_BASE.replace(/\/api$/, "");
let currentUser = readStoredUser();
let adminComplaints = [];
let selectedComplaintId = null;
let adminDepartmentScope = null;
let latestNotifications = [];

const DEPARTMENT_SLUGS = {
  "Maintenance": "maintenance",
  "IT": "it",
  "Student Affairs": "student-affairs",
  "Housekeeping": "housekeeping",
  "General Administration": "general-administration",
};

function departmentDashboardUrl(department) {
  const slug = DEPARTMENT_SLUGS[department];
  return appPageUrl(slug ? `departments/${slug}.html` : "departments/index.html");
}

function departmentLoginUrl(department) {
  const slug = DEPARTMENT_SLUGS[department];
  return appPageUrl(slug ? `dept-logins/${slug}.html` : "dept-logins/index.html");
}

function appPageUrl(path) {
  return ["department", "department-login"].includes(document.body.dataset.page) ? `../${path}` : path;
}

function readStoredUser() {
  try { return JSON.parse(localStorage.getItem("cc_user")); } catch { return null; }
}

function saveSession(token, user) {
  localStorage.setItem("cc_token", token);
  localStorage.setItem("cc_user", JSON.stringify(user));
  currentUser = user;
}

function clearSession() {
  localStorage.removeItem("cc_token");
  localStorage.removeItem("cc_user");
  currentUser = null;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = localStorage.getItem("cc_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && document.body.dataset.page !== "login") clearSession();
    const error = new Error(data.error || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[char]);
}

function statusClass(status) { return `status-${String(status).toLowerCase().replaceAll(" ", "-")}`; }
const STATUS_CLASSES = ["status-submitted", "status-under-review", "status-in-progress", "status-resolved"];
function syncStatusSelect(select) {
  select.classList.add("status-select");
  select.classList.remove(...STATUS_CLASSES);
  const nextClass = statusClass(select.value);
  if (STATUS_CLASSES.includes(nextClass)) select.classList.add(nextClass);
}
function initializeStatusSelects() {
  document.querySelectorAll("#statusFilter, #updateStatus").forEach(select => {
    [...select.options].forEach(option => {
      const optionClass = statusClass(option.value || option.textContent.trim());
      if (STATUS_CLASSES.includes(optionClass)) option.classList.add(optionClass);
    });
    syncStatusSelect(select);
    select.addEventListener("change", () => syncStatusSelect(select));
  });
}
function priorityClass(priority) { return `priority-${String(priority).toLowerCase()}`; }
function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "—"; }

function showMessage(message, type = "error", elementId = "formMessage") {
  const box = document.getElementById(elementId);
  if (!box) return;
  box.textContent = message;
  box.className = `form-message show ${type}`;
}

function clearMessage(elementId = "formMessage") {
  const box = document.getElementById(elementId);
  if (box) box.className = "form-message";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3000);
}

function notificationMarkup(notification) {
  return `<article class="notification-item${notification.read ? "" : " unread"}"><p>${escapeHtml(notification.message)}</p><span>${formatDate(notification.created_at)}</span></article>`;
}

function renderNotifications() {
  const unread = latestNotifications.filter(notification => !notification.read).length;
  const button = document.getElementById("notificationButton");
  const count = document.getElementById("notificationCount");
  const menu = document.getElementById("notificationMenu");
  const trackedList = document.getElementById("studentNotifications");
  const trackedCount = document.getElementById("studentNotificationCount");
  if (count) {
    count.textContent = unread ? String(unread) : "";
    count.hidden = !unread;
  }
  if (button) button.setAttribute("aria-label", unread ? `${unread} unread notifications` : "Notifications");
  const content = latestNotifications.length
    ? latestNotifications.map(notificationMarkup).join("")
    : emptyState("No notifications", "Status updates and overdue alerts will appear here.");
  if (menu) menu.innerHTML = `<div class="notification-menu-heading"><strong>Notifications</strong>${unread ? '<button id="markNotificationsRead" class="button button-secondary button-small" type="button">Mark all read</button>' : ""}</div><div class="notification-list">${content}</div>`;
  if (trackedList) trackedList.innerHTML = content;
  if (trackedCount) trackedCount.textContent = unread ? `${unread} unread` : `${latestNotifications.length} total`;
  const markRead = document.getElementById("markNotificationsRead");
  if (markRead) markRead.addEventListener("click", markAllNotificationsRead);
}

async function markAllNotificationsRead() {
  try {
    await api("/notifications/read", { method: "PUT", body: JSON.stringify({}) });
    latestNotifications = latestNotifications.map(notification => ({ ...notification, read: true }));
    renderNotifications();
  } catch (error) { showToast(error.message); }
}

async function loadNotifications() {
  if (!currentUser) return;
  try {
    const data = await api("/notifications");
    latestNotifications = data.notifications;
    renderNotifications();
  } catch (_error) {
    // Notifications are supplementary; do not interrupt the main page if they fail.
  }
}

function renderNavigation() {
  const nav = document.getElementById("appNav");
  if (!nav || !currentUser) return;
  const navigation = currentUser.role === "admin" || currentUser.role === "department_admin"
    ? `<a class="button button-secondary button-small" href="${currentUser.role === "admin" ? appPageUrl("dashboard.html") : departmentDashboardUrl(currentUser.department)}">Dashboard</a>`
    : `<a class="button button-secondary button-small" href="complaint.html">Complaint</a><a class="button button-secondary button-small" href="track.html">Track</a>`;
  nav.innerHTML = `<span class="nav-user">${escapeHtml(currentUser.name)}</span>${navigation}<div class="notification-control"><button id="notificationButton" class="button button-secondary button-small" type="button" aria-expanded="false">Alerts <span id="notificationCount" class="notification-count" hidden></span></button><div id="notificationMenu" class="notification-menu" hidden></div></div><button id="logoutButton" class="button button-small" type="button">Log out</button>`;
  document.getElementById("notificationButton").addEventListener("click", () => {
    const menu = document.getElementById("notificationMenu");
    const open = menu.hidden;
    menu.hidden = !open;
    document.getElementById("notificationButton").setAttribute("aria-expanded", String(open));
  });
  document.getElementById("logoutButton").addEventListener("click", () => {
    clearSession();
    window.location.href = appPageUrl("index.html");
  });
}

async function requireUser(allowedRoles) {
  try {
    const data = await api("/me");
    currentUser = data.user;
    localStorage.setItem("cc_user", JSON.stringify(data.user));
    if (!allowedRoles.includes(currentUser.role)) {
      window.location.replace(currentUser.role === "admin" ? "dashboard.html" : currentUser.role === "department_admin" ? departmentDashboardUrl(currentUser.department) : "complaint.html");
      return null;
    }
    renderNavigation();
    loadNotifications();
    window.setInterval(loadNotifications, 60 * 1000);
    return currentUser;
  } catch (_error) {
    clearSession();
    const page = document.body.dataset.page;
    const fallbackLogin = page === "department"
      ? departmentLoginUrl(document.body.dataset.department)
      : page === "admin" ? "admin-login.html" : "login.html";
    window.location.replace(fallbackLogin);
    return null;
  }
}

function complaintRow(complaint) {
  return `<a class="complaint-row" href="complaint.html?id=${encodeURIComponent(complaint.complaint_id)}">
    <div class="complaint-main"><div class="complaint-code">${escapeHtml(complaint.complaint_id)}</div><div class="complaint-title">${escapeHtml(complaint.title)}</div><div class="complaint-meta">${escapeHtml(complaint.category)} · ${escapeHtml(complaint.department)} · ${formatDate(complaint.created_at)}</div></div>
    <div class="complaint-side"><span class="badge ${priorityClass(complaint.priority)}">${escapeHtml(complaint.priority)}</span><span class="badge ${statusClass(complaint.status)}">${escapeHtml(complaint.status)}</span></div>
  </a>`;
}

function emptyState(title, detail) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}</div>`;
}

function recommendationFor(text, category) {
  const phrase = `${text || ""} ${category || ""}`.toLowerCase();
  if (["exposed wire", "exposed electrical wire", "live wire", "electric shock", "fire", "gas leak", "unsafe", "hazard"].some(word => phrase.includes(word))) return { department: "Maintenance", priority: "Critical" };
  if (["wifi", "wi-fi", "internet", "network", "computer", "projector", "software", "website"].some(word => phrase.includes(word))) return { department: "IT", priority: "High" };
  if (["broken fan", "fan", "light", "bench", "chair", "leak", "plumbing", "toilet", "electrical"].some(word => phrase.includes(word))) return { department: "Maintenance", priority: "Medium" };
  if (["harassment", "bullying", "security", "theft", "violence"].some(word => phrase.includes(word))) return { department: "Student Affairs", priority: "High" };
  if (["clean", "garbage", "washroom", "waste"].some(word => phrase.includes(word))) return { department: "Housekeeping", priority: "Medium" };
  return { department: "General Administration", priority: "Medium" };
}

function initializeLogin() {
  const form = document.getElementById("loginForm");
  const loginPage = document.body.dataset.page;
  const expectedDepartment = document.body.dataset.department;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearMessage();
    try {
      const data = await api("/login", { method: "POST", body: JSON.stringify({ identifier: document.getElementById("loginIdentifier").value, password: document.getElementById("loginPassword").value }) });
      if (loginPage === "admin-login" && !data.user.is_super_admin) throw new Error("This login is for Admin-001.");
      const adminDepartmentLogin = loginPage === "department-login" && data.user.is_super_admin;
      if (loginPage === "department-login" && !adminDepartmentLogin && (data.user.role !== "department_admin" || data.user.department !== expectedDepartment)) {
        throw new Error(`Use the ${expectedDepartment} department login for that account.`);
      }
      if (loginPage === "login" && (data.user.role === "admin" || data.user.role === "department_admin")) {
        const message = data.user.role === "department_admin"
          ? `This account is assigned to ${data.user.department}. Use that department's login page.`
          : "Use the dedicated Admin-001 login page for this account.";
        throw new Error(message);
      }
      saveSession(data.access_token, data.user);
      if (adminDepartmentLogin) {
        window.location.href = `${departmentDashboardUrl(expectedDepartment)}?adminAccess=1`;
        return;
      }
      window.location.href = data.user.role === "admin" ? "dashboard.html" : data.user.role === "department_admin" ? departmentDashboardUrl(data.user.department) : "complaint.html";
    } catch (error) { showMessage(error.message); }
  });
}

function initializeRegister() {
  const form = document.getElementById("registerForm");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearMessage();
    const password = document.getElementById("registerPassword").value;
    if (password !== document.getElementById("confirmPassword").value) {
      showMessage("The passwords do not match.");
      return;
    }
    try {
      const data = await api("/register", { method: "POST", body: JSON.stringify({
        name: document.getElementById("name").value,
        roll_or_employee_id: document.getElementById("identifier").value,
        email: document.getElementById("registerEmail").value,
        password,
        role: document.getElementById("role").value,
      }) });
      showMessage(data.message, "success");
      form.reset();
      window.setTimeout(() => { window.location.href = "login.html"; }, 850);
    } catch (error) { showMessage(error.message); }
  });
}

async function initializeDashboard() {
  const user = await requireUser(["student", "faculty"]);
  if (!user) return;
  document.getElementById("welcomeTitle").textContent = `Hello, ${user.name.split(" ")[0]}`;
  try {
    const { complaints } = await api("/complaints/my");
    const count = status => complaints.filter(item => item.status === status).length;
    document.getElementById("countTotal").textContent = complaints.length;
    document.getElementById("countPending").textContent = count("Submitted");
    document.getElementById("countReview").textContent = count("Under Review");
    document.getElementById("countProgress").textContent = count("In Progress");
    document.getElementById("countResolved").textContent = count("Resolved");
    document.getElementById("complaintCount").textContent = `${complaints.length} total`;
    document.getElementById("complaintList").innerHTML = complaints.length ? complaints.slice(0, 8).map(complaintRow).join("") : emptyState("No complaints yet", "When you report an issue, it will appear here.");
  } catch (error) { document.getElementById("complaintList").innerHTML = emptyState("Could not load complaints", error.message); }
}

function detailMarkup(complaint) {
  const timeline = complaint.timeline.map(item => `<div class="timeline-item ${item.state}" data-status="${escapeHtml(item.label)}"><span class="timeline-dot"></span><span class="timeline-label">${escapeHtml(item.label)}</span></div>`).join("");
  const image = complaint.image_url ? `<img class="complaint-image" src="${BACKEND_BASE}${encodeURI(complaint.image_url)}" alt="Attachment for ${escapeHtml(complaint.title)}">` : "";
  const note = complaint.resolution_note ? `<div class="resolution-note">${escapeHtml(complaint.resolution_note)}</div>` : `<p class="subtle">No resolution remarks have been added yet.</p>`;
  return `<div class="page-heading"><div><a class="subtle" href="complaint.html">← Submit another complaint</a><h1>Complaint details</h1><p>Track the latest action on your report.</p></div></div>
  <div class="detail-layout"><section class="detail-card"><div class="detail-top"><div><div class="complaint-code">${escapeHtml(complaint.complaint_id)}</div><h2 class="detail-title">${escapeHtml(complaint.title)}</h2></div><span class="badge ${statusClass(complaint.status)}">${escapeHtml(complaint.status)}</span></div><p class="detail-description">${escapeHtml(complaint.description)}</p>${image}
  <div class="info-grid"><div class="info-item">Category<strong>${escapeHtml(complaint.category)}</strong></div><div class="info-item">Location<strong>${escapeHtml(complaint.location)}</strong></div><div class="info-item">Submitted<strong>${formatDate(complaint.created_at)}</strong></div><div class="info-item">Priority<strong>${escapeHtml(complaint.priority)}</strong></div><div class="info-item">Department<strong>${escapeHtml(complaint.department)}</strong></div><div class="info-item">Submitted by<strong>${escapeHtml(complaint.submitted_by)}</strong></div></div></section>
  <aside class="detail-card"><h2 class="section-title">Progress</h2><div class="timeline">${timeline}</div><h3>Resolution remarks</h3>${note}</aside></div>`;
}

async function initializeComplaint() {
  const user = await requireUser(["student", "faculty"]);
  if (!user) return;
  const complaintId = new URLSearchParams(window.location.search).get("id");
  if (complaintId) {
    document.getElementById("complaintFormView").classList.add("hidden");
    const detail = document.getElementById("complaintDetailView");
    detail.classList.remove("hidden");
    try {
      const { complaint } = await api(`/complaints/${encodeURIComponent(complaintId)}`);
      detail.innerHTML = detailMarkup(complaint);
    } catch (error) { detail.innerHTML = `<div class="content-card">${emptyState("Could not load this complaint", error.message)}</div>`; }
    return;
  }

  const title = document.getElementById("complaintTitle");
  const description = document.getElementById("description");
  const category = document.getElementById("category");
  const priority = document.getElementById("priority");
  const updateRecommendation = () => {
    const recommendation = recommendationFor(`${title.value} ${description.value}`, category.value);
    document.getElementById("suggestDepartment").textContent = `Department: ${recommendation.department}`;
    document.getElementById("suggestPriority").textContent = `Priority: ${recommendation.priority}`;
    if (!priority.dataset.changed) priority.value = recommendation.priority;
  };
  [title, description, category].forEach(element => element.addEventListener("input", updateRecommendation));
  category.addEventListener("change", updateRecommendation);
  priority.addEventListener("change", () => { priority.dataset.changed = "yes"; });
  updateRecommendation();

  document.getElementById("complaintForm").addEventListener("submit", async event => {
    event.preventDefault();
    clearMessage();
    const image = document.getElementById("image").files[0];
    if (image && image.size > 5 * 1024 * 1024) { showMessage("Image must be 5 MB or smaller."); return; }
    try {
      const data = await api("/complaints", { method: "POST", body: new FormData(event.currentTarget) });
      showToast("Complaint submitted successfully.");
      window.location.href = `complaint.html?id=${encodeURIComponent(data.complaint.complaint_id)}`;
    } catch (error) { showMessage(error.message); }
  });
}

async function initializeTrack() {
  const user = await requireUser(["student", "faculty"]);
  if (!user) return;
  const result = document.getElementById("trackingResult");
  try {
    const { complaints } = await api("/complaints/my");
    document.getElementById("trackedComplaintCount").textContent = `${complaints.length} total`;
    result.innerHTML = complaints.length
      ? complaints.map(complaintRow).join("")
      : emptyState("No complaints yet", "Submit a campus issue and its progress will appear here.");
  } catch (error) {
    result.innerHTML = emptyState("Could not load complaints", error.message);
  }
  await loadNotifications();
}

function adminRow(complaint) {
  const image = complaint.image_url
    ? `<img class="admin-detail-image" src="${BACKEND_BASE}${encodeURI(complaint.image_url)}" alt="Attachment for ${escapeHtml(complaint.title)}">`
    : `<span class="subtle">No image attached.</span>`;
  const note = complaint.resolution_note
    ? `<div class="resolution-note">${escapeHtml(complaint.resolution_note)}</div>`
    : `<span class="subtle">No resolution remarks yet.</span>`;
  return `<article class="admin-row" data-complaint-row="${escapeHtml(complaint.complaint_id)}">
    <button class="admin-row-summary" type="button" data-expand-id="${escapeHtml(complaint.complaint_id)}" aria-expanded="false">
      <span class="complaint-code">${escapeHtml(complaint.complaint_id)}</span><h3>${escapeHtml(complaint.title)}</h3><span class="admin-row-meta">${escapeHtml(complaint.category)} · ${escapeHtml(complaint.location)} · ${escapeHtml(complaint.submitted_by)}${complaint.submitted_roll_or_employee_id ? ` · ID ${escapeHtml(complaint.submitted_roll_or_employee_id)}` : ""}</span>
    </button>
    <div class="admin-row-meta">${escapeHtml(complaint.department)}<br>${formatDate(complaint.created_at)}</div>
    <div class="admin-row-actions"><span class="badge ${priorityClass(complaint.priority)}">${escapeHtml(complaint.priority)}</span><span class="badge ${statusClass(complaint.status)}">${escapeHtml(complaint.status)}</span><button class="button button-secondary button-small" type="button" data-manage-id="${escapeHtml(complaint.complaint_id)}">Manage</button></div>
    <div class="admin-expanded" id="admin-details-${escapeHtml(complaint.complaint_id)}">
      <p class="admin-description">${escapeHtml(complaint.description)}</p>
      <div class="admin-detail-grid"><div>Category<strong>${escapeHtml(complaint.category)}</strong></div><div>Location<strong>${escapeHtml(complaint.location)}</strong></div><div>Department<strong>${escapeHtml(complaint.department)}</strong></div><div>Priority<strong>${escapeHtml(complaint.priority)}</strong></div><div>Status<strong>${escapeHtml(complaint.status)}</strong></div><div>Submitted<strong>${formatDate(complaint.created_at)}</strong></div>${complaint.submitted_roll_or_employee_id ? `<div>Reporter roll / employee ID<strong>${escapeHtml(complaint.submitted_roll_or_employee_id)}</strong></div>` : ""}</div>
      <div class="admin-detail-section"><span>Resolution remarks</span>${note}</div>
      <div class="admin-detail-section"><span>Attached image</span>${image}</div>
    </div>
  </article>`;
}

async function loadAdmin() {
  const params = new URLSearchParams();
  const filterMap = [["search", "searchInput"], ["status", "statusFilter"], ["category", "categoryFilter"], ["priority", "priorityFilter"]];
  filterMap.forEach(([key, id]) => { const value = document.getElementById(id).value.trim(); if (value) params.set(key, value); });
  try {
    const isDepartmentAdmin = currentUser.role === "department_admin" || Boolean(adminDepartmentScope);
    const base = isDepartmentAdmin ? "/department" : "/admin";
    if (adminDepartmentScope) params.set("department", adminDepartmentScope);
    const query = params.toString();
    const [stats, data] = await Promise.all([api(`${base}/stats${adminDepartmentScope ? `?department=${encodeURIComponent(adminDepartmentScope)}` : ""}`), api(`${base}/complaints${query ? `?${query}` : ""}`)]);
    document.getElementById("statTotal").textContent = stats.total;
    document.getElementById("statPending").textContent = stats.pending;
    document.getElementById("statReview").textContent = stats.under_review;
    document.getElementById("statProgress").textContent = stats.in_progress;
    document.getElementById("statResolved").textContent = stats.resolved;
    adminComplaints = data.complaints;
    document.getElementById("adminComplaintCount").textContent = `${adminComplaints.length} shown`;
    document.getElementById("adminComplaintList").innerHTML = adminComplaints.length ? adminComplaints.map(adminRow).join("") : emptyState("No complaints match these filters", "Try clearing one of the filters.");
  } catch (error) { document.getElementById("adminComplaintList").innerHTML = emptyState("Could not load complaints", error.message); }
}

function openEditor(complaintId) {
  const complaint = adminComplaints.find(item => item.complaint_id === complaintId);
  if (!complaint) return;
  selectedComplaintId = complaintId;
  document.getElementById("adminEditor").classList.add("show");
  document.getElementById("editorSummary").innerHTML = `<strong>${escapeHtml(complaint.complaint_id)}</strong> · ${escapeHtml(complaint.title)}<br><span class="subtle">${escapeHtml(complaint.description)}</span>`;
  document.getElementById("updateStatus").value = complaint.status;
  syncStatusSelect(document.getElementById("updateStatus"));
  document.getElementById("updateDepartment").value = complaint.department;
  document.getElementById("updatePriority").value = complaint.priority;
  document.getElementById("updateNote").value = complaint.resolution_note || "";
  clearMessage();
  document.getElementById("adminEditor").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function initializeAdmin() {
  const user = await requireUser(["admin", "department_admin"]);
  if (!user) return;
  const isDepartmentAdmin = user.role === "department_admin";
  const isSuperAdmin = user.is_super_admin;
  const isDepartmentPage = document.body.dataset.page === "department";
  const adminRequestedDepartment = new URLSearchParams(window.location.search).get("adminAccess") === "1";
  const isAdminDepartmentView = isSuperAdmin && isDepartmentPage && adminRequestedDepartment;
  if (!isDepartmentAdmin && !user.is_super_admin) { window.location.replace("login.html"); return; }
  if (document.body.dataset.page === "admin" && isDepartmentAdmin) { window.location.replace(departmentDashboardUrl(user.department)); return; }
  if (isDepartmentPage && !isDepartmentAdmin && !isAdminDepartmentView) { window.location.replace("dashboard.html"); return; }
  const expectedDepartment = document.body.dataset.department;
  if (isDepartmentAdmin && expectedDepartment && user.department !== expectedDepartment) {
    window.location.replace(departmentDashboardUrl(user.department));
    return;
  }
  if (isAdminDepartmentView) adminDepartmentScope = expectedDepartment;
  if (isDepartmentAdmin) {
    document.getElementById("dashboardHeading").textContent = `${user.department} dashboard`;
    document.getElementById("updateDepartment").disabled = true;
  } else if (isAdminDepartmentView) {
    document.getElementById("dashboardHeading").textContent = `${expectedDepartment} dashboard — Admin access`;
    document.getElementById("updateDepartment").disabled = true;
  }
  const list = document.getElementById("adminComplaintList");
  list.addEventListener("click", event => {
    const manageButton = event.target.closest("[data-manage-id]");
    if (manageButton) {
      openEditor(manageButton.dataset.manageId);
      return;
    }
    const expandButton = event.target.closest("[data-expand-id]");
    if (expandButton) {
      const row = expandButton.closest("[data-complaint-row]");
      const expanded = row.classList.toggle("expanded");
      expandButton.setAttribute("aria-expanded", String(expanded));
    }
  });
  let filterTimer;
  ["searchInput", "statusFilter", "categoryFilter", "priorityFilter"].forEach(id => document.getElementById(id).addEventListener("input", () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(loadAdmin, 250);
  }));
  document.getElementById("closeEditor").addEventListener("click", () => document.getElementById("adminEditor").classList.remove("show"));
  document.getElementById("adminUpdateForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!selectedComplaintId) return;
    clearMessage();
    try {
      const updates = {
        status: document.getElementById("updateStatus").value,
        priority: document.getElementById("updatePriority").value,
        resolution_note: document.getElementById("updateNote").value,
      };
      if (!isDepartmentAdmin && !isAdminDepartmentView) updates.department = document.getElementById("updateDepartment").value;
      await api(`/admin/complaints/${encodeURIComponent(selectedComplaintId)}`, { method: "PUT", body: JSON.stringify(updates) });
      showToast("Complaint updated.");
      await loadAdmin();
      openEditor(selectedComplaintId);
    } catch (error) { showMessage(error.message); }
  });
  const promotionForm = document.getElementById("promotionForm");
  if (promotionForm) {
    const identifierInput = document.getElementById("promotionIdentifier");
    const departmentSelect = document.getElementById("promotionDepartment");
    const submitButton = promotionForm.querySelector('button[type="submit"]');
    const removeButton = document.getElementById("removeAdminButton");
    let lookupTimer;
    let lookupSequence = 0;

    const showPromoteAction = () => {
      submitButton.hidden = false;
      removeButton.hidden = true;
      removeButton.disabled = false;
      removeButton.textContent = "Remove as admin";
    };

    const lookUpAccount = async (identifier = identifierInput.value.trim()) => {
      const sequence = ++lookupSequence;
      showPromoteAction();
      if (!identifier) { clearMessage("promotionMessage"); return null; }
      try {
        const data = await api(`/admin/users/${encodeURIComponent(identifier)}`);
        if (sequence !== lookupSequence) return null;
        const account = data.user;
        if (account.role === "department_admin") {
          submitButton.hidden = true;
          removeButton.hidden = false;
          showMessage(`${account.roll_or_employee_id} already has ${account.department} department admin access.`, "success", "promotionMessage");
        } else if (account.role === "admin") {
          submitButton.hidden = true;
          removeButton.hidden = false;
          removeButton.disabled = true;
          removeButton.textContent = "Primary admin protected";
          showMessage("Admin-001 is the primary administrator and cannot be removed.", "error", "promotionMessage");
        } else {
          showMessage(`${account.roll_or_employee_id} is a ${account.role} account and can be assigned.`, "success", "promotionMessage");
        }
        return account;
      } catch (error) {
        if (sequence !== lookupSequence) return null;
        showPromoteAction();
        if (error.status === 404) showMessage("No account found with that roll/employee ID or email.", "error", "promotionMessage");
        else showMessage(error.message, "error", "promotionMessage");
        return null;
      }
    };

    identifierInput.addEventListener("input", () => {
      window.clearTimeout(lookupTimer);
      lookupSequence++;
      showPromoteAction();
      lookupTimer = window.setTimeout(() => lookUpAccount(), 350);
    });

    promotionForm.addEventListener("submit", async event => {
      event.preventDefault();
      window.clearTimeout(lookupTimer);
      const identifier = identifierInput.value.trim();
      const department = departmentSelect.value;
      if (!identifier) { showMessage("Enter a roll/employee ID or email.", "error", "promotionMessage"); identifierInput.focus(); return; }
      if (!department) { showMessage("Choose a department.", "error", "promotionMessage"); departmentSelect.focus(); return; }
      clearMessage("promotionMessage");
      try {
        submitButton.disabled = true;
        submitButton.textContent = "Checking account…";
        showMessage("Checking account…", "success", "promotionMessage");
        const account = await lookUpAccount(identifier);
        if (!account || account.role === "department_admin" || account.role === "admin") return;
        submitButton.disabled = true;
        submitButton.hidden = false;
        submitButton.textContent = "Assigning…";
        const data = await api(`/admin/users/${encodeURIComponent(identifier)}/promote?department=${encodeURIComponent(department)}`, { method: "PUT" });
        showMessage(`${data.user.roll_or_employee_id} is now a ${department} department admin. Their existing password is unchanged.`, "success", "promotionMessage");
        promotionForm.reset();
        lookupSequence++;
        showPromoteAction();
      } catch (error) {
        showMessage(error.message, "error", "promotionMessage");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Assign department admin";
      }
    });

    removeButton.addEventListener("click", async () => {
      const identifier = identifierInput.value.trim();
      if (!identifier) { showMessage("Enter the department admin's ID or email first.", "error", "promotionMessage"); return; }
      try {
        removeButton.disabled = true;
        removeButton.textContent = "Removing…";
        showMessage("Removing department admin access…", "success", "promotionMessage");
        const data = await api(`/admin/users/${encodeURIComponent(identifier)}/demote`, { method: "PUT" });
        showMessage(data.message, "success", "promotionMessage");
        promotionForm.reset();
        lookupSequence++;
        showPromoteAction();
      } catch (error) {
        showMessage(error.message, "error", "promotionMessage");
        removeButton.disabled = false;
        removeButton.textContent = "Remove as admin";
      }
    });
  }
  await loadAdmin();
}

function initializePasswordVisibility() {
  const eyeIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const eyeOffIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a15.8 15.8 0 0 1-3.1 3.9M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4-.8"></path></svg>';

  document.querySelectorAll('input[type="password"]').forEach(input => {
    const wrapper = document.createElement("div");
    wrapper.className = "password-input-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "password-toggle";
    toggle.setAttribute("aria-label", "Show password");
    toggle.setAttribute("aria-pressed", "false");
    toggle.title = "Show password";
    toggle.innerHTML = eyeIcon;
    toggle.addEventListener("click", () => {
      const showPassword = input.type === "password";
      input.type = showPassword ? "text" : "password";
      toggle.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
      toggle.setAttribute("aria-pressed", String(showPassword));
      toggle.title = showPassword ? "Hide password" : "Show password";
      toggle.innerHTML = showPassword ? eyeOffIcon : eyeIcon;
      input.focus();
    });
    wrapper.appendChild(toggle);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initializePasswordVisibility();
  initializeStatusSelects();
  const page = document.body.dataset.page;
  if (["login", "admin-login", "department-login"].includes(page)) initializeLogin();
  if (page === "register") initializeRegister();
  if (page === "dashboard") initializeDashboard();
  if (page === "complaint") initializeComplaint();
  if (page === "track") initializeTrack();
  if (page === "admin") initializeAdmin();
  if (page === "department") initializeAdmin();
});
