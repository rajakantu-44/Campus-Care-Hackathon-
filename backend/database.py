"""The small MongoDB setup used by CampusCare."""

import os

from pymongo import ASCENDING, MongoClient


def connect_database():
    uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/campuscare")
    client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    return client, client.get_default_database(default="campuscare")


client, db = connect_database()


def initialise_database():
    """Check the connection and create the few indexes this app needs."""
    client.admin.command("ping")
    db.users.create_index([("email", ASCENDING)], unique=True)
    db.users.create_index([("roll_or_employee_id", ASCENDING)], unique=True)
    db.complaints.create_index([("complaint_id", ASCENDING)], unique=True)
    db.complaints.create_index([("user_id", ASCENDING), ("created_at", -1)])
    db.complaints.create_index([("status", ASCENDING)])
