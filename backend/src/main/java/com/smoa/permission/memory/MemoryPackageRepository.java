package com.smoa.permission.memory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;

import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;

/** local-memory 전용 가상 저장소. */
@Repository
@Profile("local-memory")
public class MemoryPackageRepository implements PackageRepository {

    private final Map<String, PermissionPackage> byId = new LinkedHashMap<>();

    static String key(String name) {
        return name.strip().toLowerCase(Locale.ROOT);
    }

    @Override
    public synchronized Optional<PermissionPackage> findById(String packageId) {
        return Optional.ofNullable(byId.get(packageId));
    }

    @Override
    public synchronized List<PermissionPackage> findAll() {
        List<PermissionPackage> all = new ArrayList<>(byId.values());
        all.sort(Comparator.comparing(p -> key(p.name())));
        return all;
    }

    @Override
    public synchronized Optional<PermissionPackage> findByNameKey(String nameKey) {
        return byId.values().stream().filter(p -> key(p.name()).equals(nameKey)).findFirst();
    }

    @Override
    public synchronized void insert(PermissionPackage pkg) {
        if (byId.containsKey(pkg.packageId()) || findByNameKey(key(pkg.name())).isPresent()) {
            throw new DuplicateKeyException("duplicate package");
        }
        byId.put(pkg.packageId(), pkg);
    }

    @Override
    public synchronized void update(PermissionPackage pkg) {
        if (!byId.containsKey(pkg.packageId())) {
            throw new IllegalStateException("존재하지 않는 패키지입니다.");
        }
        for (PermissionPackage other : byId.values()) {
            if (!other.packageId().equals(pkg.packageId()) && key(other.name()).equals(key(pkg.name()))) {
                throw new DuplicateKeyException("duplicate package name");
            }
        }
        byId.put(pkg.packageId(), pkg);
    }

    @Override
    public synchronized void delete(String packageId) {
        byId.remove(packageId);
    }
}
