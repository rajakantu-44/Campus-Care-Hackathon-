<?php
declare(strict_types=1);

/*
 * Run while the PHP server is listening on http://127.0.0.1:5055.
 * It creates uniquely named test documents and removes all of them in finally,
 * leaving accounts and complaints that existed before the test unchanged.
 */

require dirname(__DIR__) . '/bootstrap.php';

function assert_test(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function api_call(string $method, string $path, ?array $json = null, ?array $form = null, ?string $token = null): array
{
    $headers = ['Accept: application/json'];
    $content = '';
    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
        $content = json_encode($json, JSON_THROW_ON_ERROR);
    } elseif ($form !== null) {
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
        $content = http_build_query($form);
    }
    if ($token !== null) $headers[] = "Authorization: Bearer {$token}";
    $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $content, 'ignore_errors' => true, 'timeout' => 10]]);
    $body = file_get_contents('http://127.0.0.1:5055' . $path, false, $context);
    $statusLine = $http_response_header[0] ?? '';
    preg_match('/\s(\d{3})\s/', $statusLine, $match);
    return ['status' => (int) ($match[1] ?? 0), 'body' => json_decode((string) $body, true)];
}

$suffix = bin2hex(random_bytes(5));
$studentIdentifier = "PHP-TEST-STUDENT-{$suffix}";
$studentEmail = "php-test-{$suffix}@example.invalid";
$adminIdentifier = "PHP-TEST-ADMIN-{$suffix}";
$complaintId = 'CC-PHP-TEST-' . strtoupper($suffix);
$studentId = null;
$adminId = null;

try {
    $health = api_call('GET', '/api/health');
    assert_test($health['status'] === 200 && ($health['body']['database_connected'] ?? false) === true, 'Health endpoint failed.');

    $registered = api_call('POST', '/api/register', [
        'name' => 'PHP Integration Student',
        'roll_or_employee_id' => $studentIdentifier,
        'email' => $studentEmail,
        'password' => 'TestPass123!',
        'role' => 'student',
    ]);
    assert_test($registered['status'] === 201, 'Student registration failed.');

    $studentLogin = api_call('POST', '/api/login', ['identifier' => $studentIdentifier, 'password' => 'TestPass123!']);
    assert_test($studentLogin['status'] === 200 && isset($studentLogin['body']['access_token']), 'Student login failed.');
    $studentToken = $studentLogin['body']['access_token'];
    $student = find_user_by_identifier($studentIdentifier);
    assert_test($student !== null, 'Registered student was not found.');
    $studentId = $student['_id'];

    $now = now_utc();
    $complaint = [
        'complaint_id' => $complaintId,
        'user_id' => $studentId,
        'title' => 'PHP integration test projector',
        'description' => 'Temporary test document. It is deleted after verification.',
        'category' => 'IT & Network',
        'location' => 'Test lab',
        'priority' => 'High',
        'department' => 'IT',
        'image' => null,
        'anonymous' => false,
        'status' => 'Submitted',
        'resolution_note' => '',
        'created_at' => $now,
        'updated_at' => $now,
        'status_updated_at' => $now,
    ];
    mongo_insert_one('complaints_it', $complaint);

    $tracked = api_call('GET', '/api/complaints/my', null, null, $studentToken);
    assert_test($tracked['status'] === 200 && count($tracked['body']['complaints'] ?? []) >= 1, 'Complaint tracking endpoint failed.');

    $adminId = mongo_insert_one('administration', [
        'name' => 'PHP Integration IT Admin',
        'roll_or_employee_id' => $adminIdentifier,
        'email' => "php-admin-{$suffix}@example.invalid",
        'password_hash' => password_hash('AdminPass123!', PASSWORD_BCRYPT),
        'role' => 'department_admin',
        'department' => 'IT',
        'created_at' => now_utc(),
    ]);
    $adminLogin = api_call('POST', '/api/login', ['identifier' => $adminIdentifier, 'password' => 'AdminPass123!']);
    assert_test($adminLogin['status'] === 200 && isset($adminLogin['body']['access_token']), 'Department-admin login failed.');

    $updated = api_call('PUT', '/api/admin/complaints/' . rawurlencode($complaintId), ['status' => 'In Progress', 'priority' => 'High', 'resolution_note' => 'Test status update.'], null, $adminLogin['body']['access_token']);
    assert_test($updated['status'] === 200 && ($updated['body']['complaint']['status'] ?? '') === 'In Progress', 'Department status update failed: ' . json_encode($updated));

    $notifications = api_call('GET', '/api/notifications', null, null, $studentToken);
    $hasStatusNotification = array_filter($notifications['body']['notifications'] ?? [], static fn (array $notification): bool => ($notification['kind'] ?? '') === 'status_change' && ($notification['complaint_id'] ?? '') === $complaintId);
    assert_test($notifications['status'] === 200 && count($hasStatusNotification) === 1, 'Student status notification was not created.');

    $master = mongo_find_one('administration', ['roll_or_employee_id' => 'ADMIN-001']);
    assert_test($master !== null, 'Admin-001 is required for overdue-notification verification.');
    mongo_update_one('complaints_it', ['complaint_id' => $complaintId], ['$set' => ['status_updated_at' => new MongoDB\BSON\UTCDateTime((int) floor((microtime(true) - 31 * 24 * 60 * 60) * 1000))]]);
    $masterNotifications = api_call('GET', '/api/notifications', null, null, make_token($master));
    $hasStaleNotification = array_filter($masterNotifications['body']['notifications'] ?? [], static fn (array $notification): bool => ($notification['kind'] ?? '') === 'stale_complaint' && ($notification['complaint_id'] ?? '') === $complaintId);
    assert_test($masterNotifications['status'] === 200 && count($hasStaleNotification) === 1, 'Thirty-day master-admin notification was not created.');

    echo "PHP API integration tests passed: health, registration/login, tracking, department update, student notification, and 30-day escalation." . PHP_EOL;
} finally {
    mongo_delete_many('notifications', ['complaint_id' => $complaintId]);
    mongo_delete_one('complaints_it', ['complaint_id' => $complaintId]);
    if ($studentId instanceof MongoDB\BSON\ObjectId) mongo_delete_one('student', ['_id' => $studentId]);
    if ($adminId instanceof MongoDB\BSON\ObjectId) mongo_delete_one('administration', ['_id' => $adminId]);
}
