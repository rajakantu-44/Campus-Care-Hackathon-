<?php
declare(strict_types=1);

// Router for: php -S 127.0.0.1:5000 -t frontend backend/router.php
$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (str_starts_with($path, '/uploads/')) {
    $filename = basename(rawurldecode(substr($path, strlen('/uploads/'))));
    $file = __DIR__ . '/uploads/' . $filename;
    if (!is_file($file)) {
        http_response_code(404);
        return true;
    }
    $mime = mime_content_type($file) ?: 'application/octet-stream';
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($file));
    readfile($file);
    return true;
}
if (str_starts_with($path, '/api/')) {
    require __DIR__ . '/api.php';
    return true;
}
return false;
