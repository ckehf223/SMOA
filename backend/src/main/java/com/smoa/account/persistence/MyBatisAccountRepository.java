package com.smoa.account.persistence;

import java.util.List;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.account.Account;
import com.smoa.audit.AuditStamp;
import com.smoa.account.AccountRepository;

/** local/prod 저장소 어댑터. SQL 은 mapper XML 에 있으며 이 클래스는 행 ↔ 도메인 변환만 한다. */
@Repository
@Profile({"local", "prod"})
public class MyBatisAccountRepository implements AccountRepository {

    private final AccountMapper mapper;

    public MyBatisAccountRepository(AccountMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public Optional<Account> findById(String id) {
        return Optional.ofNullable(mapper.selectAccountById(id)).map(MyBatisAccountRepository::toAccount);
    }

    @Override
    public Optional<Account> findByUsernameKey(String usernameKey) {
        return Optional.ofNullable(mapper.selectAccountByUsernameKey(usernameKey))
                .map(MyBatisAccountRepository::toAccount);
    }

    @Override
    public List<Account> findAll() {
        return mapper.selectAllAccounts().stream().map(MyBatisAccountRepository::toAccount).toList();
    }

    @Override
    public long countByPackageId(String packageId) {
        return mapper.countAccountsByPackageId(packageId);
    }

    @Override
    public long countActiveSuperAdmins() {
        return mapper.countActiveSuperAdmins();
    }

    @Override
    public long count() {
        return mapper.countAllAccounts();
    }

    @Override
    public void lockAdminMutation() {
        mapper.lockSuperAdminPackages();
    }

    @Override
    public void insert(Account account) {
        mapper.insertAccount(toRow(account));
    }

    @Override
    public void update(Account account) {
        int updated = mapper.updateAccount(toRow(account));
        if (updated != 1) {
            throw new IllegalStateException("계정 수정 결과가 1건이 아닙니다: " + updated);
        }
    }

    private static AccountRow toRow(Account a) {
        AccountRow row = new AccountRow();
        row.id = a.id();
        row.username = a.username();
        row.usernameKey = a.usernameKey();
        row.displayName = a.displayName();
        row.packageId = a.packageId();
        row.passwordHash = a.passwordHash();
        row.active = a.active();
        row.credentialVersion = a.credentialVersion();
        AuditStamp stamp = AuditStamp.current();
        row.sysUserId = stamp.userId();
        row.sysIp = stamp.ip();
        row.sysAt = stamp.utcNow();
        return row;
    }

    private static Account toAccount(AccountRow row) {
        return new Account(row.id, row.username, row.displayName, row.packageId, row.passwordHash,
                Boolean.TRUE.equals(row.active), row.credentialVersion == null ? 0L : row.credentialVersion);
    }
}
