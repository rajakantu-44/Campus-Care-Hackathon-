"""A transparent rule-based department and priority recommendation."""


def classify(text, category=""):
    phrase = f"{text or ''} {category or ''}".lower()

    if any(word in phrase for word in ("exposed wire", "exposed electrical wire", "live wire", "electric shock", "fire", "gas leak", "unsafe", "hazard")):
        return {"department": "Maintenance", "priority": "Critical"}
    if any(word in phrase for word in ("wifi", "wi-fi", "internet", "network", "computer", "projector", "software", "website")):
        return {"department": "IT", "priority": "High"}
    if any(word in phrase for word in ("broken fan", "fan", "light", "bench", "chair", "leak", "plumbing", "toilet", "electrical")):
        return {"department": "Maintenance", "priority": "Medium"}
    if any(word in phrase for word in ("harassment", "bullying", "security", "theft", "violence")):
        return {"department": "Student Affairs", "priority": "High"}
    if any(word in phrase for word in ("clean", "garbage", "washroom", "waste")):
        return {"department": "Housekeeping", "priority": "Medium"}
    return {"department": "General Administration", "priority": "Medium"}
