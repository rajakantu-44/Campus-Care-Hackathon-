"""MongoDB connections, collections, and one-time migration helpers."""

import os
import re

from bson import ObjectId
from pymongo import ASCENDING, MongoClient


DEPARTMENTS = {
    "Maintenance": "complaints_maintenance",
    "IT": "complaints_it",
    "Student Affairs": "complaints_student_affairs",
    "Housekeeping": "complaints_housekeeping",
    "General Administration": "complaints_general_administration",
}


def connect_database():
    uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/campuscare")
    client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    return client, client.get_default_database(default="campuscare")


client, db = connect_database()


def user_collection(role):
    """Store admin identities separately from student and faculty identities."""
    return db.administration if role in {"admin", "department_admin"} else db.student


def find_user_by_id(user_id):
    user = db.administration.find_one({"_id": user_id})
    return user or db.student.find_one({"_id": user_id})


def find_user_by_identifier(identifier):
    query = {"$or": [
        {"roll_or_employee_id": {"$regex": f"^{re.escape(identifier)}$", "$options": "i"}},
        {"email": identifier.lower()},
    ]}
    return db.administration.find_one(query) or db.student.find_one(query)


def complaint_collection(department):
    return db[DEPARTMENTS.get(department, DEPARTMENTS["General Administration"])]


def all_complaints(query=None):
    records = []
    for collection_name in DEPARTMENTS.values():
        records.extend(db[collection_name].find(query or {}))
    return sorted(records, key=lambda item: item.get("created_at"), reverse=True)


def find_complaint(complaint_id):
    for collection_name in DEPARTMENTS.values():
        complaint = db[collection_name].find_one({"complaint_id": complaint_id})
        if complaint:
            return complaint, db[collection_name]
    return None, None


def initialise_database():
    """Connect, migrate legacy records, and create indexes for the split layout."""
    client.admin.command("ping")

    # Preserve user IDs so existing complaint references and JWTs remain valid.
    if "users" in db.list_collection_names():
        for user in db.users.find():
            destination = user_collection(user.get("role"))
            destination.replace_one({"_id": user["_id"]}, user, upsert=True)
        db.users.drop()

    # Move old shared complaints to one collection per assigned department.
    if "complaints" in db.list_collection_names():
        for complaint in db.complaints.find():
            destination = complaint_collection(complaint.get("department"))
            destination.replace_one({"_id": complaint["_id"]}, complaint, upsert=True)
        db.complaints.drop()

    for collection_name in ("administration", "student"):
        collection = db[collection_name]
        collection.create_index([("email", ASCENDING)], unique=True)
        collection.create_index([("roll_or_employee_id", ASCENDING)], unique=True)

    for collection_name in DEPARTMENTS.values():
        collection = db[collection_name]
        collection.create_index([("complaint_id", ASCENDING)], unique=True)
        collection.create_index([("user_id", ASCENDING), ("created_at", -1)])
        collection.create_index([("status", ASCENDING)])
