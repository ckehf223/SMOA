package com.smoa.permission.persistence;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import com.smoa.audit.AuditStamp;
import com.smoa.permission.ActionPermission;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;
import com.smoa.permission.ScopeType;

/**
 * local/prod 저장소 어댑터(AUTHMSTR/AUTHDTL/AUTHORG). 알 수 없는 범위 값은 데이터 손상으로 보고 실패(거부)한다.
 * SQL 은 mapper XML 에 있으며 이 클래스는 행 ↔ 도메인 변환과 감사 값 채우기만 한다.
 */
@Repository
@Profile({"local", "prod"})
public class MyBatisPackageRepository implements PackageRepository {

    private final PackageMapper mapper;

    public MyBatisPackageRepository(PackageMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public Optional<PermissionPackage> findById(String packageId) {
        return Optional.ofNullable(mapper.selectPackageById(packageId)).map(this::toPackage);
    }

    @Override
    public List<PermissionPackage> findAll() {
        return mapper.selectAllPackages().stream().map(this::toPackage).toList();
    }

    @Override
    public Optional<PermissionPackage> findByNameKey(String nameKey) {
        return Optional.ofNullable(mapper.selectPackageByNameKey(nameKey)).map(this::toPackage);
    }

    @Override
    @Transactional
    public void insert(PermissionPackage pkg) {
        mapper.insertPackage(toRow(pkg));
        replaceChildren(pkg);
    }

    @Override
    @Transactional
    public void update(PermissionPackage pkg) {
        int updated = mapper.updatePackage(toRow(pkg));
        if (updated != 1) {
            throw new IllegalStateException("패키지 수정 결과가 1건이 아닙니다: " + updated);
        }
        replaceChildren(pkg);
    }

    @Override
    @Transactional
    public void delete(String packageId) {
        mapper.deletePermissionsByPackageId(packageId);
        mapper.deleteDistrictsByPackageId(packageId);
        mapper.deletePackage(packageId);
    }

    private void replaceChildren(PermissionPackage pkg) {
        AuditStamp stamp = AuditStamp.current();
        mapper.deletePermissionsByPackageId(pkg.packageId());
        for (Map.Entry<String, ActionPermission> e : pkg.permissions().entrySet()) {
            PackagePermissionRow row = new PackagePermissionRow();
            row.packageId = pkg.packageId();
            row.programId = e.getKey();
            row.accessAllowed = e.getValue().access();
            row.readAllowed = e.getValue().read();
            row.writeAllowed = e.getValue().write();
            row.exportAllowed = e.getValue().export();
            row.sysUserId = stamp.userId();
            row.sysIp = stamp.ip();
            row.sysAt = stamp.utcNow();
            mapper.insertPermission(row);
        }
        mapper.deleteDistrictsByPackageId(pkg.packageId());
        for (DistrictKey key : pkg.scope().districts()) {
            PackageDistrictRow row = new PackageDistrictRow();
            row.packageId = pkg.packageId();
            row.regionCode = key.regionCode();
            row.districtCode = key.districtCode();
            row.sysUserId = stamp.userId();
            row.sysIp = stamp.ip();
            row.sysAt = stamp.utcNow();
            mapper.insertDistrict(row);
        }
    }

    static PackageRow toRow(PermissionPackage p) {
        PackageRow row = new PackageRow();
        row.packageId = p.packageId();
        row.name = p.name();
        row.nameKey = p.name().strip().toLowerCase(Locale.ROOT);
        row.active = p.active();
        row.superAdmin = p.superAdmin();
        row.scopeType = p.scope().type().name();
        AuditStamp stamp = AuditStamp.current();
        row.sysUserId = stamp.userId();
        row.sysIp = stamp.ip();
        row.sysAt = stamp.utcNow();
        return row;
    }

    private PermissionPackage toPackage(PackageRow row) {
        Map<String, ActionPermission> permissions = new HashMap<>();
        for (PackagePermissionRow p : mapper.selectPermissionsByPackageId(row.packageId)) {
            permissions.put(p.programId, new ActionPermission(Boolean.TRUE.equals(p.accessAllowed),
                    Boolean.TRUE.equals(p.readAllowed), Boolean.TRUE.equals(p.writeAllowed),
                    Boolean.TRUE.equals(p.exportAllowed)));
        }
        ScopeType type;
        try {
            type = ScopeType.valueOf(row.scopeType);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new IllegalStateException("권한 패키지의 데이터 범위 값이 올바르지 않습니다: packageId=" + row.packageId, e);
        }
        DataScope scope;
        if (type == ScopeType.ALL) {
            scope = DataScope.all();
        } else {
            Set<DistrictKey> districts = new HashSet<>();
            for (PackageDistrictRow d : mapper.selectDistrictsByPackageId(row.packageId)) {
                // 형식이 맞지 않는 구역 배정은 건너뛴다(허용 범위를 넓히지 않는 방향 = fail-closed).
                if (DistrictKey.valid(d.regionCode, d.districtCode)) {
                    districts.add(new DistrictKey(d.regionCode, d.districtCode));
                }
            }
            scope = DataScope.org(districts);
        }
        return new PermissionPackage(row.packageId, row.name, Boolean.TRUE.equals(row.active),
                Boolean.TRUE.equals(row.superAdmin), permissions, scope);
    }
}
