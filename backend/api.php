<?php
declare(strict_types=1);

use MongoDB\BSON\ObjectId;
use MongoDB\BSON\Regex;

require __DIR__ . '/bootstrap.php';

function api_response(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function department_filter_from_request(): array
{
    $filter = [];
    foreach (['status', 'category', 'priority'] as $field) {
        $value = trim((string) ($_GET[$field] ?? ''));
        if ($value !== '') $filter[$field] = $value;
    }
    $search = trim((string) ($_GET['search'] ?? ''));
    if ($search !== '') {
        $filter['$or'] = [
            ['complaint_id' => new Regex($search, 'i')],
            ['title' => new Regex($search, 'i')],
            ['location' => new Regex($search, 'i')],
        ];
    }
    return $filter;
}

function complaint_stats(iterable $complaints): array
{
    $grouped = [];
    foreach ($complaints as $complaint) {
        $status = $complaint['status'] ?? 'Submitted';
        $grouped[$status] = ($grouped[$status] ?? 0) + 1;
    }
    return [
        'total' => array_sum($grouped),
        'pending' => $grouped['Submitted'] ?? 0,
        'under_review' => $grouped['Under Review'] ?? 0,
        'in_progress' => $grouped['In Progress'] ?? 0,
        'resolved' => $grouped['Resolved'] ?? 0,
    ];
}

function create_complaint(array $user): never
{
    $values = [];
    foreach (['title', 'description', 'category', 'location'] as $key) {
        $values[$key] = request_value($_POST, $key);
    }
    $missing = array_keys(array_filter($values, static fn (string $value): bool => $value === ''));
    if ($missing) throw new HttpError(400, 'Missing required field(s): ' . implode(', ', $missing) . '.');

    $recommendation = classify_complaint($values['title'] . ' ' . $values['description'], $values['category']);
    $requestedPriority = ucwords(strtolower(request_value($_POST, 'priority')));
    $imageName = null;
    if (isset($_FILES['image']) && ($_FILES['image']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
        $upload = $_FILES['image'];
        if (($upload['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) throw new HttpError(400, 'Image upload failed.');
        if ((int) ($upload['size'] ?? 0) > 5 * 1024 * 1024) throw new HttpError(413, 'Image must be 5 MB or smaller.');
        $sourceName = (string) ($upload['name'] ?? '');
        $extension = strtolower(pathinfo($sourceName, PATHINFO_EXTENSION));
        if (!in_array($extension, ['jpg', 'jpeg', 'png', 'webp'], true)) throw new HttpError(400, 'Only JPG, JPEG, PNG, and WEBP images are allowed.');
        $safeName = preg_replace('/[^A-Za-z0-9._-]/', '_', basename($sourceName));
        $imageName = bin2hex(random_bytes(16)) . '_' . $safeName;
        $uploadDir = __DIR__ . '/uploads';
        if (!is_dir($uploadDir) && !mkdir($uploadDir, 0775, true) && !is_dir($uploadDir)) throw new RuntimeException('Unable to create upload directory.');
        if (!move_uploaded_file((string) $upload['tmp_name'], $uploadDir . '/' . $imageName)) throw new RuntimeException('Unable to save uploaded image.');
    }

    $now = now_utc();
    $complaint = [
        'complaint_id' => next_complaint_id(),
        'user_id' => $user['_id'],
        ...$values,
        'priority' => in_array($requestedPriority, PRIORITIES, true) ? $requestedPriority : $recommendation['priority'],
        'department' => $recommendation['department'],
        'image' => $imageName,
        'anonymous' => in_array(strtolower(request_value($_POST, 'anonymous')), ['true', '1', 'yes', 'on'], true),
        'status' => 'Submitted',
        'resolution_note' => '',
        'created_at' => $now,
        'updated_at' => $now,
        'status_updated_at' => $now,
    ];
    mongo_insert_one(collection_for_department($complaint['department']), $complaint);
    api_response(['message' => 'Complaint submitted successfully.', 'complaint' => complaint_output($complaint, $user['name']), 'recommendation' => $recommendation], 201);
}

function update_complaint_record(array $actor, string $complaintId): never
{
    [$complaint, $sourceCollection] = find_complaint(strtoupper($complaintId));
    $superAdmin = is_super_admin($actor);
    if (!$complaint || (!$superAdmin && ($complaint['department'] ?? '') !== ($actor['department'] ?? ''))) throw new HttpError(404, 'Complaint not found.');
    $data = json_input();
    $updates = [];
    $previousStatus = $complaint['status'] ?? 'Submitted';
    $statusChanged = false;
    if (array_key_exists('status', $data)) {
        if (!in_array($data['status'], STATUSES, true)) throw new HttpError(400, 'Invalid status.');
        $updates['status'] = $data['status'];
        $statusChanged = $data['status'] !== $previousStatus;
    }
    if (array_key_exists('priority', $data)) {
        if (!in_array($data['priority'], PRIORITIES, true)) throw new HttpError(400, 'Invalid priority.');
        $updates['priority'] = $data['priority'];
    }
    if (array_key_exists('department', $data)) {
        if (!$superAdmin) throw new HttpError(403, 'Only Admin-001 can reassign a complaint to another department.');
        $department = trim((string) $data['department']);
        if ($department === '') throw new HttpError(400, 'Department cannot be empty.');
        $updates['department'] = $department;
    }
    if (array_key_exists('resolution_note', $data)) $updates['resolution_note'] = trim((string) $data['resolution_note']);
    if (!$updates) throw new HttpError(400, 'Nothing to update.');

    $updates['updated_at'] = now_utc();
    if ($statusChanged) $updates['status_updated_at'] = $updates['updated_at'];
    $destination = collection_for_department($updates['department'] ?? $complaint['department']);
    if ($destination === $sourceCollection) {
        mongo_update_one($sourceCollection, ['_id' => $complaint['_id']], ['$set' => $updates]);
    } else {
        $moved = array_merge($complaint, $updates);
        mongo_update_one($destination, ['_id' => $complaint['_id']], ['$set' => document_without_id($moved)], true);
        mongo_delete_one($sourceCollection, ['_id' => $complaint['_id']]);
    }
    $complaint = array_merge($complaint, $updates);
    if ($statusChanged) create_notification($complaint['user_id'], 'status_change', "Your complaint {$complaint['complaint_id']} changed from {$previousStatus} to {$updates['status']}.", $complaint['complaint_id']);
    $reporter = $superAdmin ? find_user_by_id($complaint['user_id']) : null;
    api_response(['message' => 'Complaint updated.', 'complaint' => complaint_output($complaint, $reporter['name'] ?? null, $reporter['roll_or_employee_id'] ?? null, $superAdmin)]);
}

function dispatch_api(string $method, string $path): never
{
    if ($method === 'POST' && $path === '/api/login') {
        $data = json_input();
        $identifier = request_value($data, 'identifier') ?: request_value($data, 'email');
        $password = (string) ($data['password'] ?? '');
        if ($identifier === '' || $password === '') throw new HttpError(400, 'Roll/Employee ID (or email) and password are required.');
        $user = find_user_by_identifier($identifier);
        if (!$user || !password_verify($password, (string) $user['password_hash'])) throw new HttpError(401, 'Invalid email or password.');
        api_response(['message' => 'Login successful.', 'access_token' => make_token($user), 'user' => safe_user($user)]);
    }

    if ($method === 'POST' && $path === '/api/register') {
        $data = json_input();
        $required = ['name', 'roll_or_employee_id', 'email', 'password', 'role'];
        $missing = array_values(array_filter($required, static fn (string $field): bool => request_value($data, $field) === ''));
        if ($missing) throw new HttpError(400, 'Missing required field(s): ' . implode(', ', $missing) . '.');
        $role = strtolower(request_value($data, 'role'));
        if (!in_array($role, ['student', 'faculty'], true)) throw new HttpError(400, 'New accounts must be registered as Student or Faculty.');
        $password = (string) $data['password'];
        if (strlen($password) < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
        $user = [
            'name' => request_value($data, 'name'),
            'roll_or_employee_id' => request_value($data, 'roll_or_employee_id'),
            'email' => strtolower(request_value($data, 'email')),
            'password_hash' => password_hash($password, PASSWORD_BCRYPT),
            'role' => $role,
            'created_at' => now_utc(),
        ];
        if (find_user_by_identifier($user['roll_or_employee_id']) || find_user_by_identifier($user['email'])) throw new HttpError(409, 'An account with this email or roll/employee ID already exists.');
        try {
            $user['_id'] = mongo_insert_one('student', $user);
        } catch (BulkWriteException) {
            throw new HttpError(409, 'An account with this email or roll/employee ID already exists.');
        }
        api_response(['message' => 'Registration successful. Please log in.', 'user' => safe_user($user)], 201);
    }

    if ($method === 'GET' && $path === '/api/me') api_response(['user' => safe_user(current_user())]);

    if ($method === 'POST' && $path === '/api/complaints') create_complaint(require_roles(['student', 'faculty']));

    if ($method === 'GET' && $path === '/api/complaints/my') {
        $user = require_roles(['student', 'faculty']);
        $records = all_complaints(['user_id' => $user['_id']]);
        api_response(['complaints' => array_map(static fn (array $item): array => complaint_output($item, $user['name'], $user['roll_or_employee_id'], true), $records)]);
    }

    if ($method === 'GET' && preg_match('#^/api/complaints/([^/]+)$#', $path, $match)) {
        $user = require_roles(['student', 'faculty']);
        [$complaint] = find_complaint(strtoupper(rawurldecode($match[1])));
        if (!$complaint) throw new HttpError(404, 'Complaint not found.');
        if ((string) $complaint['user_id'] !== (string) $user['_id']) throw new HttpError(403, 'You can only view your own complaints.');
        api_response(['complaint' => complaint_output($complaint, $user['name'])]);
    }

    if ($method === 'GET' && $path === '/api/notifications') {
        $user = current_user();
        if (is_super_admin($user)) check_stale_complaints();
        $records = mongo_find('notifications', ['user_id' => $user['_id']], ['sort' => ['created_at' => -1], 'limit' => 50]);
        api_response(['notifications' => array_map('notification_output', $records)]);
    }

    if ($method === 'PUT' && $path === '/api/notifications/read') {
        $user = current_user();
        $data = json_input();
        $filter = ['user_id' => $user['_id'], 'read' => false];
        if (array_key_exists('notification_ids', $data)) {
            if (!is_array($data['notification_ids'])) throw new HttpError(400, 'notification_ids must be a list.');
            $ids = [];
            try {
                foreach ($data['notification_ids'] as $id) $ids[] = new ObjectId((string) $id);
            } catch (Throwable) {
                throw new HttpError(400, 'A notification ID is invalid.');
            }
            $filter['_id'] = ['$in' => $ids];
        }
        $updated = mongo_update_many('notifications', $filter, ['$set' => ['read' => true, 'read_at' => now_utc()]]);
        api_response(['message' => 'Notifications marked as read.', 'updated' => $updated]);
    }

    if ($method === 'GET' && $path === '/api/admin/complaints') {
        require_super_admin();
        $complaints = all_complaints(department_filter_from_request());
        $reporters = [];
        $ids = array_values(array_unique(array_map(static fn (array $item): string => (string) $item['user_id'], $complaints)));
        foreach (['student', 'administration'] as $collection) {
            foreach (mongo_find($collection, ['_id' => ['$in' => array_map(static fn (string $id): ObjectId => new ObjectId($id), $ids)]], ['projection' => ['name' => 1, 'roll_or_employee_id' => 1]]) as $reporter) {
                $reporters[(string) $reporter['_id']] = $reporter;
            }
        }
        api_response(['complaints' => array_map(static fn (array $item): array => complaint_output($item, $reporters[(string) $item['user_id']]['name'] ?? null, $reporters[(string) $item['user_id']]['roll_or_employee_id'] ?? null, true), $complaints)]);
    }

    if ($method === 'GET' && $path === '/api/department/complaints') {
        $user = current_user();
        $department = accessed_department($user, trim((string) ($_GET['department'] ?? '')));
        $filter = department_filter_from_request();
        $filter['department'] = $department;
        $records = mongo_find(collection_for_department($department), $filter, ['sort' => ['created_at' => -1]]);
        api_response(['complaints' => array_map(static fn (array $item): array => complaint_output($item), $records)]);
    }

    if ($method === 'GET' && $path === '/api/admin/stats') {
        require_super_admin();
        api_response(complaint_stats(all_complaints()));
    }

    if ($method === 'GET' && $path === '/api/department/stats') {
        $user = current_user();
        $department = accessed_department($user, trim((string) ($_GET['department'] ?? '')));
        api_response(complaint_stats(mongo_find(collection_for_department($department), ['department' => $department])));
    }

    if ($method === 'PUT' && preg_match('#^/api/admin/complaints/([^/]+)$#', $path, $match)) update_complaint_record(require_dashboard_user(), rawurldecode($match[1]));

    if ($method === 'GET' && preg_match('#^/api/admin/users/([^/]+)$#', $path, $match)) {
        require_super_admin();
        $account = find_user_by_identifier(rawurldecode($match[1]));
        if (!$account) throw new HttpError(404, 'No account was found with that roll/employee ID or email.');
        api_response(['user' => safe_user($account)]);
    }

    if ($method === 'PUT' && preg_match('#^/api/admin/users/([^/]+)/promote$#', $path, $match)) {
        require_super_admin();
        $department = trim((string) ($_GET['department'] ?? ''));
        if (!array_key_exists($department, DEPARTMENTS)) throw new HttpError(400, 'Choose a valid department.');
        $account = find_user_by_identifier(rawurldecode($match[1]));
        if (!$account || !in_array($account['role'], ['student', 'faculty', 'department_admin'], true)) throw new HttpError(404, 'No account was found with that roll/employee ID or email.');
        $source = user_collection($account['role']);
        if ($account['role'] !== 'department_admin') $account['admin_previous_role'] = $account['role'];
        $account['role'] = 'department_admin';
        $account['department'] = $department;
        try {
            mongo_update_one('administration', ['_id' => $account['_id']], ['$set' => document_without_id($account)], true);
        } catch (BulkWriteException) {
            throw new HttpError(409, 'That account could not be promoted because its ID or email is already in use.');
        }
        if ($source !== 'administration') mongo_delete_one($source, ['_id' => $account['_id']]);
        api_response(['message' => "{$account['name']} is now an administrator for {$account['department']}.", 'user' => safe_user($account)]);
    }

    if ($method === 'PUT' && preg_match('#^/api/admin/users/([^/]+)/demote$#', $path, $match)) {
        require_super_admin();
        $account = find_user_by_identifier(rawurldecode($match[1]));
        if (!$account) throw new HttpError(404, 'No account was found with that roll/employee ID or email.');
        if (is_super_admin($account)) throw new HttpError(403, 'The primary Admin-001 account cannot be removed.');
        if (($account['role'] ?? '') !== 'department_admin') throw new HttpError(400, 'This account is not a department admin.');
        $originalRole = in_array($account['admin_previous_role'] ?? 'student', ['student', 'faculty'], true) ? $account['admin_previous_role'] : 'student';
        $account['role'] = $originalRole;
        unset($account['department'], $account['admin_previous_role']);
        try {
            mongo_update_one($originalRole === 'student' || $originalRole === 'faculty' ? 'student' : 'student', ['_id' => $account['_id']], ['$set' => document_without_id($account), '$unset' => ['department' => '', 'admin_previous_role' => '']], true);
        } catch (BulkWriteException) {
            throw new HttpError(409, 'The account could not be restored because its ID or email is already in use.');
        }
        mongo_delete_one('administration', ['_id' => $account['_id']]);
        api_response(['message' => "Department admin access was removed for {$account['name']}; the account is restored as {$originalRole}.", 'user' => safe_user($account)]);
    }

    if ($method === 'GET' && $path === '/api/health') {
        mongo_command('admin', ['ping' => 1]);
        api_response(['service' => 'CampusCare PHP API', 'database_connected' => true]);
    }

    throw new HttpError(404, 'Resource not found.');
}

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Authorization, Content-Type');
header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    create_indexes();
    ensure_account_seeds();
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    dispatch_api($_SERVER['REQUEST_METHOD'] ?? 'GET', rtrim($path, '/') ?: '/');
} catch (HttpError $error) {
    api_response(['error' => $error->getMessage()], $error->status);
} catch (Throwable $error) {
    error_log('CampusCare PHP API error: ' . $error->getMessage());
    api_response(['error' => 'The server could not complete this request.'], 500);
}
