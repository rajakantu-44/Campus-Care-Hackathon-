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
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

from classifier import classify  # noqa: E402
from database import (  # noqa: E402
    all_complaints,
    complaint_collection,
    db,
    find_complaint,
    find_user_by_id,
    find_user_by_identifier,
    initialise_database,
    user_collection,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
app.config["UPLOAD_FOLDER"] = str(Path(__file__).parent / "uploads")
Path(app.config["UPLOAD_FOLDER"]).mkdir(exist_ok=True)
CORS(app, resources={r"/api/*": {"origins": "*"}})

STATUSES = ["Submitted", "Under Review", "In Progress", "Resolved"]
PRIORITIES = ["Low", "Medium", "High", "Critical"]
DEPARTMENTS = ["Maintenance", "IT", "Student Affairs", "Housekeeping", "General Administration"]
DEPARTMENT_ADMIN_SEEDS = [
    ("Maintenance", "Maintenance Admin", "MAINT-001", "maintenance-admin@campuscare.local", "MAINTENANCE_ADMIN_PASSWORD"),
    ("IT", "IT Admin", "IT-001", "it-admin@campuscare.local", "IT_ADMIN_PASSWORD"),
    ("Student Affairs", "Student Affairs Admin", "STUAFF-001", "student-affairs-admin@campuscare.local", "STUDENT_AFFAIRS_ADMIN_PASSWORD"),
    ("Housekeeping", "Housekeeping Admin", "HOUSEKEEP-001", "housekeeping-admin@campuscare.local", "HOUSEKEEPING_ADMIN_PASSWORD"),
    ("General Administration", "General Administration Admin", "GENADMIN-001", "general-admin@campuscare.local", "GENERAL_ADMIN_PASSWORD"),
]
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}


def safe_user(user):
    """Only expose non-sensitive fields. password_hash is intentionally absent."""
    return {
        "id": str(user["_id"]),
        "name": user["name"],
        "roll_or_employee_id": user["roll_or_employee_id"],
        "email": user["email"],
        "role": user["role"],
        "department": user.get("department"),
        "is_super_admin": is_super_admin(user),
        "created_at": user["created_at"].isoformat(),
    }


def is_super_admin(user):
    return user.get("role") == "admin" and user.get("roll_or_employee_id", "").strip().upper() == "ADMIN-001"


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
            user = find_user_by_id(ObjectId(payload["sub"]))
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


def super_admin_required(view):
    @wraps(view)
    @token_required
    def wrapped(*args, **kwargs):
        if not is_super_admin(g.current_user):
            return jsonify({"error": "Only Admin-001 can access this resource."}), 403
        return view(*args, **kwargs)
    return wrapped


def dashboard_required(view):
    @wraps(view)
    @token_required
    def wrapped(*args, **kwargs):
        if not is_super_admin(g.current_user) and g.current_user.get("role") != "department_admin":
            return jsonify({"error": "You do not have permission to access this resource."}), 403
        return view(*args, **kwargs)
    return wrapped


def department_access_required(view):
    """Allow department admins in their own department and Admin-001 in a selected one."""
    @wraps(view)
    @token_required
    def wrapped(*args, **kwargs):
        if is_super_admin(g.current_user):
            department = str(request.args.get("department", "")).strip()
            if department not in DEPARTMENTS:
                return jsonify({"error": "Choose a valid department."}), 400
            g.access_department = department
        elif g.current_user.get("role") == "department_admin":
            g.access_department = g.current_user.get("department")
        else:
            return jsonify({"error": "You do not have permission to access this resource."}), 403
        return view(*args, **kwargs)
    return wrapped


def complaint_output(complaint, reporter_name=None, reporter_id=None, reveal_identity=False):
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
        "submitted_by": (reporter_name or "CampusCare user") if reveal_identity else ("Anonymous" if complaint.get("anonymous") else "CampusCare user"),
        "submitted_roll_or_employee_id": reporter_id if reveal_identity else None,
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
    """Ensure the configured Admin-001 account exists with the configured credentials."""
    email = os.getenv("ADMIN_EMAIL", "").strip().lower()
    password = os.getenv("ADMIN_PASSWORD", "")
    if not email or not password:
        return
    existing = db.administration.find_one({"roll_or_employee_id": "ADMIN-001"})
    if existing:
        db.administration.update_one({"_id": existing["_id"]}, {
            "$set": {
                "name": os.getenv("ADMIN_NAME", "CampusCare Administrator"),
                "email": email,
                "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
                "role": "admin",
            },
            "$unset": {"department": ""},
        })
        return
    if db.administration.find_one({"email": email}) or db.student.find_one({"email": email}):
        print("Configured ADMIN_EMAIL belongs to another account; Admin-001 was not created.")
        return
    db.administration.insert_one({
        "name": os.getenv("ADMIN_NAME", "CampusCare Administrator"),
        "roll_or_employee_id": "ADMIN-001",
        "email": email,
        "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        "role": "admin",
        "created_at": datetime.now(timezone.utc),
    })
    print(f"Created local admin account: {email}")


def ensure_department_admins():
    """Create or refresh one scoped department account per configured department."""
    for department, name, identifier, email, password_key in DEPARTMENT_ADMIN_SEEDS:
        password = os.getenv(password_key, "")
        if not password:
            print(f"Skipping {identifier}: {password_key} is not configured.")
            continue
        existing = db.administration.find_one({"roll_or_employee_id": identifier})
        if existing:
            db.administration.update_one({"_id": existing["_id"]}, {
                "$set": {
                    "name": name,
                    "email": email,
                    "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
                    "role": "department_admin",
                    "department": department,
                },
            })
            continue
        if db.administration.find_one({"email": email}) or db.student.find_one({"email": email}):
            print(f"Skipping {identifier}: configured email already belongs to another account.")
            continue
        db.administration.insert_one({
            "name": name,
            "roll_or_employee_id": identifier,
            "email": email,
            "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
            "role": "department_admin",
            "department": department,
            "created_at": datetime.now(timezone.utc),
        })


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    identifier = str(data.get("identifier", data.get("email", ""))).strip()
    password = str(data.get("password", ""))
    if not identifier or not password:
        return jsonify({"error": "Roll/Employee ID (or email) and password are required."}), 400
    user = find_user_by_identifier(identifier)
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
        if find_user_by_identifier(user["roll_or_employee_id"]) or find_user_by_identifier(user["email"]):
            raise DuplicateKeyError("account identifier already exists")
        user["_id"] = db.student.insert_one(user).inserted_id
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
    complaint_collection(complaint["department"]).insert_one(complaint)
    return jsonify({
        "message": "Complaint submitted successfully.",
        "complaint": complaint_output(complaint, g.current_user["name"]),
        "recommendation": recommendation,
    }), 201


@app.get("/api/complaints/my")
@roles_required("student", "faculty")
def my_complaints():
    records = sorted(all_complaints({"user_id": g.current_user["_id"]}), key=lambda item: item["created_at"], reverse=True)
    return jsonify({"complaints": [complaint_output(item, g.current_user["name"], g.current_user["roll_or_employee_id"], True) for item in records]})


@app.get("/api/complaints/<complaint_id>")
@roles_required("student", "faculty")
def complaint_details(complaint_id):
    complaint, _collection = find_complaint(complaint_id.upper())
    if not complaint:
        return jsonify({"error": "Complaint not found."}), 404
    if complaint["user_id"] != g.current_user["_id"]:
        return jsonify({"error": "You can only view your own complaints."}), 403
    return jsonify({"complaint": complaint_output(complaint, g.current_user["name"])})


@app.get("/api/admin/complaints")
@super_admin_required
def admin_complaints():
    query = {}
    for field in ("status", "category", "priority"):
        value = request.args.get(field, "").strip()
        if value:
            query[field] = value
    search = request.args.get("search", "").strip()
    if search:
        query["$or"] = [{field: {"$regex": search, "$options": "i"}} for field in ("complaint_id", "title", "location")]
    complaints = all_complaints(query)
    ids = {item["user_id"] for item in complaints}
    reporters = {}
    if ids:
        for collection_name in ("student", "administration"):
            for item in db[collection_name].find({"_id": {"$in": list(ids)}}, {"name": 1, "roll_or_employee_id": 1}):
                reporters[item["_id"]] = item
    return jsonify({"complaints": [complaint_output(item, reporters.get(item["user_id"], {}).get("name"), reporters.get(item["user_id"], {}).get("roll_or_employee_id"), True) for item in complaints]})


@app.get("/api/department/complaints")
@department_access_required
def department_complaints():
    query = {"department": g.access_department}
    for field in ("status", "category", "priority"):
        value = request.args.get(field, "").strip()
        if value:
            query[field] = value
    search = request.args.get("search", "").strip()
    if search:
        query["$and"] = [{"$or": [{field: {"$regex": search, "$options": "i"}} for field in ("complaint_id", "title", "location")]}]
    complaints = complaint_collection(g.access_department).find(query).sort("created_at", -1)
    return jsonify({"complaints": [complaint_output(item) for item in complaints]})


@app.get("/api/admin/stats")
@super_admin_required
def admin_stats():
    grouped = {}
    for complaint in all_complaints():
        status = complaint.get("status", "Submitted")
        grouped[status] = grouped.get(status, 0) + 1
    return jsonify({
        "total": sum(grouped.values()),
        "pending": grouped.get("Submitted", 0),
        "under_review": grouped.get("Under Review", 0),
        "in_progress": grouped.get("In Progress", 0),
        "resolved": grouped.get("Resolved", 0),
    })


@app.get("/api/department/stats")
@department_access_required
def department_stats():
    grouped = {}
    for complaint in complaint_collection(g.access_department).find():
        status = complaint.get("status", "Submitted")
        grouped[status] = grouped.get(status, 0) + 1
    return jsonify({
        "total": sum(grouped.values()),
        "pending": grouped.get("Submitted", 0),
        "under_review": grouped.get("Under Review", 0),
        "in_progress": grouped.get("In Progress", 0),
        "resolved": grouped.get("Resolved", 0),
    })


@app.put("/api/admin/complaints/<complaint_id>")
@dashboard_required
def update_complaint(complaint_id):
    data = request.get_json(silent=True) or {}
    super_admin = is_super_admin(g.current_user)
    complaint, source_collection = find_complaint(complaint_id.upper())
    if not complaint or (not super_admin and complaint.get("department") != g.current_user.get("department")):
        return jsonify({"error": "Complaint not found."}), 404
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
        if not super_admin:
            return jsonify({"error": "Only Admin-001 can reassign a complaint to another department."}), 403
        department = str(data["department"]).strip()
        if not department:
            return jsonify({"error": "Department cannot be empty."}), 400
        updates["department"] = department
    if "resolution_note" in data:
        updates["resolution_note"] = str(data["resolution_note"]).strip()
    if not updates:
        return jsonify({"error": "Nothing to update."}), 400

    updates["updated_at"] = datetime.now(timezone.utc)
    destination = complaint_collection(updates.get("department", complaint.get("department")))
    if destination.name == source_collection.name:
        complaint = source_collection.find_one_and_update(
            {"_id": complaint["_id"]}, {"$set": updates}, return_document=ReturnDocument.AFTER
        )
    else:
        complaint.update(updates)
        destination.replace_one({"_id": complaint["_id"]}, complaint, upsert=True)
        source_collection.delete_one({"_id": complaint["_id"]})
    reporter = find_user_by_id(complaint["user_id"]) if super_admin else None
    return jsonify({"message": "Complaint updated.", "complaint": complaint_output(complaint, reporter.get("name") if reporter else None, reporter.get("roll_or_employee_id") if reporter else None, super_admin)})


@app.put("/api/admin/users/<identifier>/promote")
@super_admin_required
def promote_user(identifier):
    """Assign an existing student/faculty account to one department."""
    department = str(request.args.get("department", "")).strip()
    if department not in DEPARTMENTS:
        return jsonify({"error": "Choose a valid department."}), 400
    account = find_user_by_identifier(identifier)
    if not account or account.get("role") not in {"student", "faculty", "department_admin"}:
        return jsonify({"error": "No account was found with that roll/employee ID or email."}), 404
    source = user_collection(account["role"])
    if account.get("role") != "department_admin":
        account["admin_previous_role"] = account["role"]
    account.update({"role": "department_admin", "department": department})
    if source.name == db.administration.name:
        db.administration.replace_one({"_id": account["_id"]}, account)
    else:
        try:
            db.administration.replace_one({"_id": account["_id"]}, account, upsert=True)
        except DuplicateKeyError:
            return jsonify({"error": "That account could not be promoted because its ID or email is already in use."}), 409
        source.delete_one({"_id": account["_id"]})
    return jsonify({"message": f"{account['name']} is now an administrator for {account['department']}.", "user": safe_user(account)})


@app.get("/api/admin/users/<identifier>")
@super_admin_required
def admin_user_lookup(identifier):
    """Look up an account for the primary admin's promotion controls."""
    account = find_user_by_identifier(identifier)
    if not account:
        return jsonify({"error": "No account was found with that roll/employee ID or email."}), 404
    return jsonify({"user": safe_user(account)})


@app.put("/api/admin/users/<identifier>/demote")
@super_admin_required
def demote_user(identifier):
    """Remove department-admin access and return the account to its prior role."""
    account = find_user_by_identifier(identifier)
    if not account:
        return jsonify({"error": "No account was found with that roll/employee ID or email."}), 404
    if is_super_admin(account):
        return jsonify({"error": "The primary Admin-001 account cannot be removed."}), 403
    if account.get("role") != "department_admin":
        return jsonify({"error": "This account is not a department admin."}), 400

    original_role = account.get("admin_previous_role", "student")
    if original_role not in {"student", "faculty"}:
        original_role = "student"
    account["role"] = original_role
    account.pop("department", None)
    account.pop("admin_previous_role", None)
    destination = user_collection(original_role)
    try:
        destination.replace_one({"_id": account["_id"]}, account, upsert=True)
    except DuplicateKeyError:
        return jsonify({"error": "The account could not be restored because its ID or email is already in use."}), 409
    db.administration.delete_one({"_id": account["_id"]})
    return jsonify({"message": f"Department admin access was removed for {account['name']}; the account is restored as {original_role}.", "user": safe_user(account)})


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
        ensure_department_admins()
        print("MongoDB connected. CampusCare API is ready.")
    except Exception as error:
        print(f"MongoDB connection warning: {error}")
        print("Start MongoDB before using the API.")
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")), debug=False)
