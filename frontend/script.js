// CampusCare's entire browser-side behavior lives here so the HTML/CSS can be redesigned freely.
const API_BASE = "http://localhost:5000/api";
const BACKEND_BASE = API_BASE.replace(/\/api$/, "");
let currentUser = readStoredUser();
let adminComplaints = [];
let selectedComplaintId = null;

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
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[char]);
}

function statusClass(status) { return `status-${String(status).toLowerCase().replaceAll(" ", "-")}`; }
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

function renderNavigation() {
  const nav = document.getElementById("appNav");
  if (!nav || !currentUser) return;
  const navigation = currentUser.role === "admin"
    ? `<a class="button button-secondary button-small" href="dashboard.html">Dashboard</a>`
    : `<a class="button button-secondary button-small" href="complaint.html">Complaint</a><a class="button button-secondary button-small" href="track.html">Track</a>`;
  nav.innerHTML = `<span class="nav-user">${escapeHtml(currentUser.name)}</span>${navigation}<button id="logoutButton" class="button button-small" type="button">Log out</button>`;
  document.getElementById("logoutButton").addEventListener("click", () => {
    clearSession();
    window.location.href = "index.html";
  });
}

async function requireUser(allowedRoles) {
  try {
    const data = await api("/me");
    currentUser = data.user;
    localStorage.setItem("cc_user", JSON.stringify(data.user));
    if (!allowedRoles.includes(currentUser.role)) {
      window.location.replace(currentUser.role === "admin" ? "dashboard.html" : "complaint.html");
      return null;
    }
    renderNavigation();
    return currentUser;
  } catch (_error) {
    clearSession();
    window.location.replace("login.html");
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
  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearMessage();
    try {
      const data = await api("/login", { method: "POST", body: JSON.stringify({ identifier: document.getElementById("loginIdentifier").value, password: document.getElementById("loginPassword").value }) });
      saveSession(data.access_token, data.user);
      window.location.href = data.user.role === "admin" ? "dashboard.html" : "complaint.html";
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
  const timeline = complaint.timeline.map(item => `<div class="timeline-item ${item.state}"><span class="timeline-dot"></span><span class="timeline-label">${escapeHtml(item.label)}</span></div>`).join("");
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
      <span class="complaint-code">${escapeHtml(complaint.complaint_id)}</span><h3>${escapeHtml(complaint.title)}</h3><span class="admin-row-meta">${escapeHtml(complaint.category)} · ${escapeHtml(complaint.location)} · ${escapeHtml(complaint.submitted_by)}</span>
    </button>
    <div class="admin-row-meta">${escapeHtml(complaint.department)}<br>${formatDate(complaint.created_at)}</div>
    <div class="admin-row-actions"><span class="badge ${priorityClass(complaint.priority)}">${escapeHtml(complaint.priority)}</span><span class="badge ${statusClass(complaint.status)}">${escapeHtml(complaint.status)}</span><button class="button button-secondary button-small" type="button" data-manage-id="${escapeHtml(complaint.complaint_id)}">Manage</button></div>
    <div class="admin-expanded" id="admin-details-${escapeHtml(complaint.complaint_id)}">
      <p class="admin-description">${escapeHtml(complaint.description)}</p>
      <div class="admin-detail-grid"><div>Category<strong>${escapeHtml(complaint.category)}</strong></div><div>Location<strong>${escapeHtml(complaint.location)}</strong></div><div>Department<strong>${escapeHtml(complaint.department)}</strong></div><div>Priority<strong>${escapeHtml(complaint.priority)}</strong></div><div>Status<strong>${escapeHtml(complaint.status)}</strong></div><div>Submitted<strong>${formatDate(complaint.created_at)}</strong></div></div>
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
    const [stats, data] = await Promise.all([api("/admin/stats"), api(`/admin/complaints${params.toString() ? `?${params}` : ""}`)]);
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
  document.getElementById("updateDepartment").value = complaint.department;
  document.getElementById("updatePriority").value = complaint.priority;
  document.getElementById("updateNote").value = complaint.resolution_note || "";
  clearMessage();
  document.getElementById("adminEditor").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function initializeAdmin() {
  const user = await requireUser(["admin"]);
  if (!user) return;
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
      await api(`/admin/complaints/${encodeURIComponent(selectedComplaintId)}`, { method: "PUT", body: JSON.stringify({
        status: document.getElementById("updateStatus").value,
        department: document.getElementById("updateDepartment").value,
        priority: document.getElementById("updatePriority").value,
        resolution_note: document.getElementById("updateNote").value,
      }) });
      showToast("Complaint updated.");
      await loadAdmin();
      openEditor(selectedComplaintId);
    } catch (error) { showMessage(error.message); }
  });
  document.getElementById("promotionForm").addEventListener("submit", async event => {
    event.preventDefault();
    clearMessage("promotionMessage");
    const identifier = document.getElementById("promotionIdentifier").value.trim();
    try {
      const data = await api(`/admin/users/${encodeURIComponent(identifier)}/promote`, { method: "PUT" });
      showMessage(data.message, "success", "promotionMessage");
      event.currentTarget.reset();
    } catch (error) { showMessage(error.message, "error", "promotionMessage"); }
  });
  await loadAdmin();
}

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "login") initializeLogin();
  if (page === "register") initializeRegister();
  if (page === "dashboard") initializeDashboard();
  if (page === "complaint") initializeComplaint();
  if (page === "track") initializeTrack();
  if (page === "admin") initializeAdmin();
});
