package com.smoa.account;

import java.util.List;
import java.util.Optional;

/** 계정 저장소 계약. 계정은 packageId 하나만 가진다. */
public interface AccountRepository {

    Optional<Account> findById(String id);

    /** 대소문자를 구분하지 않는 로그인 ID 키({@link Account#usernameKey(String)})로 조회. */
    Optional<Account> findByUsernameKey(String usernameKey);

    /** 로그인 ID 키 오름차순. */
    List<Account> findAll();

    long countByPackageId(String packageId);

    /** 활성 계정 중 활성 총관리자 시스템 패키지에 속한 수. */
    long countActiveSuperAdmins();

    /** 같은 로그인 ID 키가 있으면 {@code DuplicateKeyException}. */
    void insert(Account account);

    long count();

    /**
     * 계정·패키지 변경 직렬화용 DB 행 잠금(총관리자 패키지 행 FOR UPDATE). 트랜잭션 안에서 가장 먼저 호출한다.
     * 메모리 구현은 아무 것도 하지 않는다(JVM 락만 사용).
     */
    default void lockAdminMutation() {
    }

    /** 표시명·비밀번호 해시·활성·credentialVersion·packageId 를 교체한다. */
    void update(Account account);
}
