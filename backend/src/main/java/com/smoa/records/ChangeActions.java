package com.smoa.records;

import java.util.Map;

/** CHGLOG.ACTION_NAME 과 {@link HistoryEntry} 유형의 대응. 알 수 없는 동작(이관 원본 등)은 동작명을 그대로 유형으로 쓴다. */
public final class ChangeActions {

    private static final Map<String, String> TYPE_TO_ACTION = Map.of(
            HistoryEntry.CREATED, "person.create",
            HistoryEntry.UPDATED, "person.update",
            HistoryEntry.STAGE_CHANGED, "person.stage",
            HistoryEntry.DROPPED, "person.dropout",
            HistoryEntry.RESTORED, "person.return",
            HistoryEntry.DELETED, "person.delete",
            HistoryEntry.UNDELETED, "person.undelete",
            HistoryEntry.PHONE_CHANGED, "person.phone");

    private ChangeActions() {
    }

    public static String actionOf(String type) {
        return TYPE_TO_ACTION.getOrDefault(type, type);
    }

    public static String typeOf(String action) {
        for (Map.Entry<String, String> e : TYPE_TO_ACTION.entrySet()) {
            if (e.getValue().equals(action)) {
                return e.getKey();
            }
        }
        return action != null && action.startsWith("activity.") ? HistoryEntry.ACTIVITY_CHANGED : action;
    }
}
