const BASE = import.meta.env.VITE_API_URL || '/api/taskflow';
const TOKEN_KEY = 'taskflow.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

async function request(method, path, body, options = {}) {
  const token = tokenStore.get();
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
  } catch {
    throw new ApiError('Cannot reach the server — check your connection', 0);
  }

  const offline = response.headers.get('X-Taskflow-Offline') === 'true';
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    if (response.status === 401) onUnauthorized();
    throw new ApiError(data.error || `Request failed (${response.status})`, response.status, data.details);
  }

  if (offline && data && typeof data === 'object') data.__offline = true;
  return data;
}

const qs = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const api = {
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  me: () => request('GET', '/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('POST', '/auth/change-password', { currentPassword, newPassword }),

  tasks: (params) => request('GET', `/tasks${qs(params)}`),
  myTasks: () => request('GET', '/tasks/mine'),
  task: (id) => request('GET', `/tasks/${id}`),
  createTask: (data) => request('POST', '/tasks', data),
  updateTask: (id, data) => request('PATCH', `/tasks/${id}`, data),
  moveTask: (id, data) => request('POST', `/tasks/${id}/move`, data),
  archiveTask: (id) => request('DELETE', `/tasks/${id}`),
  restoreTask: (id) => request('POST', `/tasks/${id}/restore`),
  addComment: (id, body) => request('POST', `/tasks/${id}/comments`, { body }),
  deleteComment: (taskId, commentId) => request('DELETE', `/tasks/${taskId}/comments/${commentId}`),
  addChecklistItem: (id, title) => request('POST', `/tasks/${id}/checklist`, { title }),
  updateChecklistItem: (taskId, itemId, data) => request('PATCH', `/tasks/${taskId}/checklist/${itemId}`, data),
  deleteChecklistItem: (taskId, itemId) => request('DELETE', `/tasks/${taskId}/checklist/${itemId}`),

  users: (params) => request('GET', `/users${qs(params)}`),
  user: (id) => request('GET', `/users/${id}`),
  createUser: (data) => request('POST', '/users', data),
  updateUser: (id, data) => request('PATCH', `/users/${id}`, data),
  resetPassword: (id) => request('POST', `/users/${id}/reset-password`),
  deactivateUser: (id) => request('DELETE', `/users/${id}`),
  permissionCatalogue: () => request('GET', '/users/permissions/catalogue'),

  departments: (params) => request('GET', `/departments${qs(params)}`),
  createDepartment: (data) => request('POST', '/departments', data),
  updateDepartment: (id, data) => request('PATCH', `/departments/${id}`, data),
  deleteDepartment: (id) => request('DELETE', `/departments/${id}`),

  statuses: (params) => request('GET', `/statuses${qs(params)}`),
  createStatus: (data) => request('POST', '/statuses', data),
  updateStatus: (id, data) => request('PATCH', `/statuses/${id}`, data),
  reorderStatuses: (order) => request('POST', '/statuses/reorder', { order }),
  deleteStatus: (id, moveTo) => request('DELETE', `/statuses/${id}${qs({ move_to: moveTo })}`),

  blackMarks: (params) => request('GET', `/blackmarks${qs(params)}`),
  createBlackMark: (data) => request('POST', '/blackmarks', data),
  waiveBlackMark: (id, reason) => request('POST', `/blackmarks/${id}/waive`, { reason }),
  restoreBlackMark: (id) => request('POST', `/blackmarks/${id}/restore`),
  review: (params) => request('GET', `/blackmarks/review${qs(params)}`),
  rules: () => request('GET', '/blackmarks/rules'),
  createRule: (data) => request('POST', '/blackmarks/rules', data),
  updateRule: (id, data) => request('PATCH', `/blackmarks/rules/${id}`, data),
  deleteRule: (id) => request('DELETE', `/blackmarks/rules/${id}`),
  runScan: () => request('POST', '/blackmarks/scan'),

  dashboard: (params) => request('GET', `/reports/dashboard${qs(params)}`),
  workloadReport: (params) => request('GET', `/reports/workload${qs(params)}`),

  settings: () => request('GET', '/settings'),
  updateSettings: (key, value) => request('PUT', `/settings/${key}`, { value }),

  notifications: () => request('GET', '/notifications'),
  markNotificationsRead: (ids) => request('POST', '/notifications/read', ids ? { ids } : {}),
};
