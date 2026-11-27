package com.smoa.permission.persistence;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * 권한 패키지 Mapper: AUTHMSTR(패키지), AUTHDTL(프로그램 권한), AUTHORG(구역 배정, 지역+구역 복합키).
 * SQL 은 mapper/permission/PackageMapper.xml. FK 는 없으므로 하위 행 삭제·재생성은 서비스 트랜잭션이 책임진다.
 */
@Mapper
public interface PackageMapper {

    PackageRow selectPackageById(@Param("packageId") String packageId);

    /** nameKey = 앞뒤 공백 제거 + 소문자 이름. */
    PackageRow selectPackageByNameKey(@Param("nameKey") String nameKey);

    /** 정렬: 이름 키 오름차순. */
    List<PackageRow> selectAllPackages();

    List<PackagePermissionRow> selectPermissionsByPackageId(@Param("packageId") String packageId);

    List<PackageDistrictRow> selectDistrictsByPackageId(@Param("packageId") String packageId);

    int insertPackage(PackageRow row);

    /** 이름·범위·활성만 바꾼다. SUPER_ADMIN_IND 는 절대 바꾸지 않는다. 영향 행 1이어야 한다. */
    int updatePackage(PackageRow row);

    int deletePackage(@Param("packageId") String packageId);

    int deletePermissionsByPackageId(@Param("packageId") String packageId);

    int insertPermission(PackagePermissionRow row);

    int deleteDistrictsByPackageId(@Param("packageId") String packageId);

    int insertDistrict(PackageDistrictRow row);
}
