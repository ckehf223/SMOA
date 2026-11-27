package com.smoa.records;

/**
 * 대상자·활동 필드 정의 계약. 키(API 이름)·형식·길이·필수 여부를 한 곳에 두어 검증·패치·DB 매핑·엑셀이 같은 정의를 쓴다.
 */
public interface RecordField {

    enum Type { STRING, TEXT, INT, DATE, TIME, BOOL, JSON }

    /** API 필드 이름이자 MyBatis 파라미터 이름. */
    String key();

    /** 오류 메시지에 쓰는 한국어 이름. */
    String label();

    Type type();

    /** STRING/TEXT/JSON 최대 길이. INT 는 사용하지 않는다. */
    int max();

    boolean required();

    /** 요청 본문으로 직접 바꿀 수 있는가(false 는 서버가 전용 경로로만 바꾼다: 단계·상태·삭제·구역 쌍). */
    boolean editable();

    /** 오늘(한국 시각) 이후 날짜를 거부하는 DATE 필드인가. */
    default boolean noFuture() {
        return false;
    }

    default int min() {
        return 0;
    }

    /** INT 필드의 최대값. */
    default int maxValue() {
        return Integer.MAX_VALUE;
    }
}
