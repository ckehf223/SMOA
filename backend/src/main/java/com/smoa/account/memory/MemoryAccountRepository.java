package com.smoa.account.memory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;

import com.smoa.account.Account;
import com.smoa.account.AccountRepository;
import com.smoa.permission.PackageRepository;

/** local-memory 전용 가상 자료 저장소. 서버를 종료하면 모두 사라진다. DB 를 사용하지 않는다. */
@Repository
@Profile("local-memory")
public class MemoryAccountRepository implements AccountRepository {

    private final Map<String, Account> byId = new LinkedHashMap<>();
    private final PackageRepository packages;

    public MemoryAccountRepository(PackageRepository packages) {
        this.packages = packages;
    }

    @Override
    public synchronized Optional<Account> findById(String id) {
        return Optional.ofNullable(byId.get(id));
    }

    @Override
    public synchronized Optional<Account> findByUsernameKey(String usernameKey) {
        return byId.values().stream().filter(a -> a.usernameKey().equals(usernameKey)).findFirst();
    }

    @Override
    public synchronized List<Account> findAll() {
        List<Account> all = new ArrayList<>(byId.values());
        all.sort(Comparator.comparing(Account::usernameKey));
        return all;
    }

    @Override
    public synchronized long count() {
        return byId.size();
    }

    @Override
    public synchronized long countByPackageId(String packageId) {
        return byId.values().stream().filter(a -> a.packageId().equals(packageId)).count();
    }

    @Override
    public synchronized long countActiveSuperAdmins() {
        return byId.values().stream().filter(Account::active)
                .filter(a -> packages.findById(a.packageId()).filter(p -> p.active() && p.superAdmin()).isPresent())
                .count();
    }

    @Override
    public synchronized void insert(Account account) {
        if (byId.containsKey(account.id()) || findByUsernameKey(account.usernameKey()).isPresent()) {
            throw new DuplicateKeyException("duplicate account");
        }
        byId.put(account.id(), account);
    }

    @Override
    public synchronized void update(Account account) {
        if (!byId.containsKey(account.id())) {
            throw new IllegalStateException("존재하지 않는 계정을 수정할 수 없습니다.");
        }
        byId.put(account.id(), account);
    }
}
