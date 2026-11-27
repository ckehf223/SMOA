package com.smoa.account.persistence;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * 계정 Mapper(USERMSTR). 계정은 AUTH_CODE(packageId) 하나만 가진다. SQL 은 mapper/account/AccountMapper.xml.
 * 로그인 ID 는 대소문자 무시(utf8mb4_general_ci)로 비교하고 PASSWORD_HASH 는 ascii_bin 으로 정확히 저장한다.
 */
@Mapper
public interface AccountMapper {

    AccountRow selectAccountById(@Param("id") String id);

    AccountRow selectAccountByUsernameKey(@Param("usernameKey") String usernameKey);

    /** 정렬: 로그인 ID 소문자 오름차순. */
    List<AccountRow> selectAllAccounts();

    long countAccountsByPackageId(@Param("packageId") String packageId);

    /** 활성 계정 중 활성이며 SUPER_ADMIN_IND='Y' 인 패키지에 속한 수. FOR UPDATE 잠금 읽기(마지막 총관리자 보호). */
    long countActiveSuperAdmins();

    /** 총관리자 패키지 행을 잠근다(계정·패키지 변경 직렬화용). 반환값은 잠근 AUTH_CODE 목록. */
    List<String> lockSuperAdminPackages();

    long countAllAccounts();

    int insertAccount(AccountRow row);

    /** USER_ID 기준. 영향 행 1이어야 한다. */
    int updateAccount(AccountRow row);
}
