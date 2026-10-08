"""CampusCare: a simple Flask API for campus complaint reporting."""

import os
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from uuid import uuid4

import bcrypt
import jwt
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory
from flask_cors import CORS
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

# The environment file is deliberately at the project root, not inside backend.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from classifier import classify  # noqa: E402
from database import db, initialise_database  # noqa: E402

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
app.config["UPLOAD_FOLDER"] = str(Path(__file__).parent / "uploads")
Path(app.config["UPLOAD_FOLDER"]).mkdir(exist_ok=True)
CORS(app, resources={r"/api/*": {"origins": "*"}})

STATUSES = ["Submitted", "Under Review", "In Progress", "Resolved"]
PRIORITIES = ["Low", "Medium", "High", "Critical"]
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}


def safe_user(user):
    """Only expose non-sensitive fields. password_hash is intentionally absent."""
    return {
        "id": str(user["_id"]),
        "name": user["name"],
        "roll_or_employee_id": user["roll_or_employee_id"],
        "email": user["email"],
        "role": user["role"],
        "created_at": user["created_at"].isoformat(),
    }


def make_token(user):
    now = datetime.now(timezone.utc)
    return jwt.encode({
        "sub": str(user["_id"]),
        "role": user["role"],
        "iat": now,
        "exp": now + timedelta(hours=24),
    }, os.getenv("JWT_SECRET", "development-secret"), algorithm="HS256")


def token_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "Authentication token is required."}), 401
        try:
            payload = jwt.decode(header.split(" ", 1)[1], os.getenv("JWT_SECRET", "development-secret"), algorithms=["HS256"])
            user = db.users.find_one({"_id": ObjectId(payload["sub"])})
            if not user:
                raise jwt.InvalidTokenError("User not found")
            g.current_user = user
        except (jwt.PyJWTError, InvalidId, TypeError, ValueError):
            return jsonify({"error": "Your session is invalid or expired. Please log in again."}), 401
        return view(*args, **kwargs)

    return wrapped


def roles_required(*roles):
    def decorator(view):
        @wraps(view)
        @token_required
        def wrapped(*args, **kwargs):
            if g.current_user["role"] not in roles:
                return jsonify({"error": "You do not have permission to access this resource."}), 403
            return view(*args, **kwargs)

        return wrapped

    return decorator


def complaint_output(complaint, reporter_name=None):
    """Turn Mongo data into browser-safe JSON without exposing user_id."""
    status = complaint.get("status", "Submitted")
    status_index = STATUSES.index(status) if status in STATUSES else 0
    return {
        "complaint_id": complaint["complaint_id"],
        "title": complaint["title"],
        "description": complaint["description"],
        "category": complaint["category"],
        "location": complaint["location"],
        "priority": complaint["priority"],
        "department": complaint["department"],
        "image": complaint.get("image"),
        "image_url": f"/uploads/{complaint['image']}" if complaint.get("image") else None,
        "anonymous": bool(complaint.get("anonymous")),
        "submitted_by": "Anonymous" if complaint.get("anonymous") else (reporter_name or "CampusCare user"),
        "status": status,
        "resolution_note": complaint.get("resolution_note", ""),
        "created_at": complaint["created_at"].isoformat(),
        "updated_at": complaint["updated_at"].isoformat(),
        "timeline": [
            {"label": label, "state": "complete" if index < status_index else "current" if index == status_index else "upcoming"}
            for index, label in enumerate(STATUSES)
        ],
    }


def allowed_image(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS


def next_complaint_id():
    counter = db.counters.find_one_and_update(
        {"_id": "complaint_counter"}, {"$inc": {"sequence": 1}}, upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return f"CC-{1000 + counter['sequence']}"


def ensure_admin():
    """Create the local demo admin once from .env; existing users are never changed."""
    email = os.getenv("ADMIN_EMAIL", "").strip().lower()
    password = os.getenv("ADMIN_PASSWORD", "")
    if not email or not password or db.users.find_one({"email": email}):
        return
    db.users.insert_one({
        "name": os.getenv("ADMIN_NAME", "CampusCare Administrator"),
        "roll_or_employee_id": "ADMIN-001",
        "email": email,
        "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        "role": "admin",
        "created_at": datetime.now(timezone.utc),
    })
    print(f"Created local admin account: {email}")


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    identifier = str(data.get("identifier", data.get("email", ""))).strip()
    password = str(data.get("password", ""))
    if not identifier or not password:
        return jsonify({"error": "Roll/Employee ID (or email) and password are required."}), 400
    user = db.users.find_one({
        "$or": [
            {"roll_or_employee_id": identifier},
            {"email": identifier.lower()},
        ]
    })
    if not user or not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        return jsonify({"error": "Invalid email or password."}), 401
    return jsonify({"message": "Login successful.", "access_token": make_token(user), "user": safe_user(user)})


@app.post("/api/register")
def register():
    """Create a normal student or faculty account. Admin access is never self-assigned."""
    data = request.get_json(silent=True) or {}
    fields = ["name", "roll_or_employee_id", "email", "password", "role"]
    missing = [field for field in fields if not str(data.get(field, "")).strip()]
    if missing:
        return jsonify({"error": f"Missing required field(s): {', '.join(missing)}."}), 400
    role = str(data["role"]).lower()
    if role not in {"student", "faculty"}:
        return jsonify({"error": "New accounts must be registered as Student or Faculty."}), 400
    password = str(data["password"])
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    user = {
        "name": str(data["name"]).strip(),
        "roll_or_employee_id": str(data["roll_or_employee_id"]).strip(),
        "email": str(data["email"]).strip().lower(),
        "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        "role": role,
        "created_at": datetime.now(timezone.utc),
    }
    try:
        user["_id"] = db.users.insert_one(user).inserted_id
    except DuplicateKeyError:
        return jsonify({"error": "An account with this email or roll/employee ID already exists."}), 409
    return jsonify({"message": "Registration successful. Please log in.", "user": safe_user(user)}), 201


@app.get("/api/me")
@token_required
def me():
    return jsonify({"user": safe_user(g.current_user)})


@app.post("/api/complaints")
@roles_required("student", "faculty")
def submit_complaint():
    values = {key: str(request.form.get(key, "")).strip() for key in ("title", "description", "category", "location")}
    missing = [key for key, value in values.items() if not value]
    if missing:
        return jsonify({"error": f"Missing required field(s): {', '.join(missing)}."}), 400

    recommendation = classify(f"{values['title']} {values['description']}", values["category"])
    requested_priority = str(request.form.get("priority", "")).strip().title()
    image_name = None
    image = request.files.get("image")
    if image and image.filename:
        if not allowed_image(image.filename):
            return jsonify({"error": "Only JPG, JPEG, PNG, and WEBP images are allowed."}), 400
        image_name = f"{uuid4().hex}_{secure_filename(image.filename)}"
        image.save(str(Path(app.config["UPLOAD_FOLDER"]) / image_name))

    now = datetime.now(timezone.utc)
    complaint = {
        "complaint_id": next_complaint_id(),
        "user_id": g.current_user["_id"],
        **values,
        "priority": requested_priority if requested_priority in PRIORITIES else recommendation["priority"],
        "department": recommendation["department"],
        "image": image_name,
        "anonymous": str(request.form.get("anonymous", "")).lower() in {"true", "1", "yes", "on"},
        "status": "Submitted",
        "resolution_note": "",
        "created_at": now,
        "updated_at": now,
    }
    db.complaints.insert_one(complaint)
    return jsonify({
        "message": "Complaint submitted successfully.",
        "complaint": complaint_output(complaint, g.current_user["name"]),
        "recommendation": recommendation,
    }), 201


@app.get("/api/complaints/my")
@roles_required("student", "faculty")
def my_complaints():
    records = db.complaints.find({"user_id": g.current_user["_id"]}).sort("created_at", -1)
    return jsonify({"complaints": [complaint_output(item, g.current_user["name"]) for item in records]})


@app.get("/api/complaints/<complaint_id>")
@roles_required("student", "faculty")
def complaint_details(complaint_id):
    complaint = db.complaints.find_one({"complaint_id": complaint_id.upper()})
    if not complaint:
        return jsonify({"error": "Complaint not found."}), 404
    if complaint["user_id"] != g.current_user["_id"]:
        return jsonify({"error": "You can only view your own complaints."}), 403
    return jsonify({"complaint": complaint_output(complaint, g.current_user["name"])})


@app.get("/api/admin/complaints")
@roles_required("admin")
def admin_complaints():
    query = {}
    for field in ("status", "category", "priority"):
        value = request.args.get(field, "").strip()
        if value:
            query[field] = value
    search = request.args.get("search", "").strip()
    if search:
        query["$or"] = [{field: {"$regex": search, "$options": "i"}} for field in ("complaint_id", "title", "location")]
    complaints = list(db.complaints.find(query).sort("created_at", -1))
    ids = {item["user_id"] for item in complaints if not item.get("anonymous")}
    names = {item["_id"]: item["name"] for item in db.users.find({"_id": {"$in": list(ids)}}, {"name": 1})} if ids else {}
    return jsonify({"complaints": [complaint_output(item, names.get(item["user_id"])) for item in complaints]})


@app.get("/api/admin/stats")
@roles_required("admin")
def admin_stats():
    grouped = {item["_id"]: item["count"] for item in db.complaints.aggregate([{"$group": {"_id": "$status", "count": {"$sum": 1}}}])}
    return jsonify({
        "total": sum(grouped.values()),
        "pending": grouped.get("Submitted", 0),
        "under_review": grouped.get("Under Review", 0),
        "in_progress": grouped.get("In Progress", 0),
        "resolved": grouped.get("Resolved", 0),
    })


@app.put("/api/admin/complaints/<complaint_id>")
@roles_required("admin")
def update_complaint(complaint_id):
    data = request.get_json(silent=True) or {}
    updates = {}
    if "status" in data:
        if data["status"] not in STATUSES:
            return jsonify({"error": "Invalid status."}), 400
        updates["status"] = data["status"]
    if "priority" in data:
        if data["priority"] not in PRIORITIES:
            return jsonify({"error": "Invalid priority."}), 400
        updates["priority"] = data["priority"]
    if "department" in data:
        department = str(data["department"]).strip()
        if not department:
            return jsonify({"error": "Department cannot be empty."}), 400
        updates["department"] = department
    if "resolution_note" in data:
        updates["resolution_note"] = str(data["resolution_note"]).strip()
    if not updates:
        return jsonify({"error": "Nothing to update."}), 400

    updates["updated_at"] = datetime.now(timezone.utc)
    complaint = db.complaints.find_one_and_update(
        {"complaint_id": complaint_id.upper()}, {"$set": updates}, return_document=ReturnDocument.AFTER
    )
    if not complaint:
        return jsonify({"error": "Complaint not found."}), 404
    return jsonify({"message": "Complaint updated.", "complaint": complaint_output(complaint)})


@app.put("/api/admin/users/<identifier>/promote")
@roles_required("admin")
def promote_user(identifier):
    """Promote a registered student/faculty account; no public admin registration exists."""
    account = db.users.find_one_and_update(
        {"$or": [
            {"roll_or_employee_id": identifier},
            {"email": identifier.lower()},
        ]},
        {"$set": {"role": "admin"}},
        return_document=ReturnDocument.AFTER,
    )
    if not account:
        return jsonify({"error": "No account was found with that roll/employee ID or email."}), 404
    return jsonify({"message": f"{account['name']} is now an admin.", "user": safe_user(account)})


@app.get("/uploads/<path:filename>")
def uploaded_image(filename):
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)


@app.get("/api/health")
def health():
    try:
        db.client.admin.command("ping")
        return jsonify({"service": "CampusCare API", "database_connected": True})
    except Exception:
        return jsonify({"service": "CampusCare API", "database_connected": False}), 503


@app.errorhandler(RequestEntityTooLarge)
def too_large(_error):
    return jsonify({"error": "Image must be 5 MB or smaller."}), 413


if __name__ == "__main__":
    try:
        initialise_database()
        ensure_admin()
        print("MongoDB connected. CampusCare API is ready.")
    except Exception as error:
        print(f"MongoDB connection warning: {error}")
        print("Start MongoDB before using the API.")
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
