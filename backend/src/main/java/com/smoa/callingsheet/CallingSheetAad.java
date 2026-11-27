package com.smoa.callingsheet;

/**
 * 콜링시트 연락처 봉투의 레코드 기준 AAD. 공통 {@code ContactVault.newAad} 는 TGMSTR 전용이므로 쓰지 않는다.
 * <ul>
 *   <li>웹에서 만든 행의 연락처: {@code SMOA:v1:<LIB>:CALLSHEET:db:<SHEET_ID>:PHONE_ENC}</li>
 *   <li>자유 문자열 속 전화번호 보존본(SOURCE_ENC): {@code SMOA:v1:<LIB>:CALLSHEET:db:<SHEET_ID>:SOURCE_ENC:<필드>:<순번>}</li>
 *   <li>향후 노션 이관 행: 원본 ID 기준 {@code SMOA:v1:<LIB>:CALLSHEET:<SOURCE_ID>:PHONE_ENC}(이번 범위 아님, INTEGRATION.md 참조)</li>
 * </ul>
 */
public final class CallingSheetAad {

    private CallingSheetAad() {
    }

    public static String phone(String libraryId, long sheetId) {
        return "SMOA:v1:" + libraryId + ":CALLSHEET:db:" + sheetId + ":PHONE_ENC";
    }

    public static String source(String libraryId, long sheetId, String fieldKey, int index) {
        return "SMOA:v1:" + libraryId + ":CALLSHEET:db:" + sheetId + ":SOURCE_ENC:" + fieldKey + ":" + index;
    }

    public static String migratedPhone(String libraryId, String sourceId) {
        return "SMOA:v1:" + libraryId + ":CALLSHEET:" + sourceId + ":PHONE_ENC";
    }
}
