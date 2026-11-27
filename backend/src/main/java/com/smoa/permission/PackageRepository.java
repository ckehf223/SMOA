package com.smoa.permission;

import java.util.List;
import java.util.Optional;

/** 권한 패키지(프로그램별 권한·구역 배정 포함) 저장소 계약. */
public interface PackageRepository {

    Optional<PermissionPackage> findById(String packageId);

    /** 이름 오름차순. */
    List<PermissionPackage> findAll();

    /** 대소문자 무시·앞뒤 공백 제거한 이름 키로 조회. */
    Optional<PermissionPackage> findByNameKey(String nameKey);

    /** 패키지와 그 프로그램 권한·구역 배정을 함께 저장한다. 같은 이름 키가 있으면 DuplicateKeyException. */
    void insert(PermissionPackage pkg);

    /** 이름·활성·프로그램 권한 전체·범위 전체를 교체한다. */
    void update(PermissionPackage pkg);

    void delete(String packageId);
}
