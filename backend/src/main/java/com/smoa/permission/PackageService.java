package com.smoa.permission;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import com.smoa.account.AccountRepository;
import com.smoa.common.ApiException;

/**
 * 권한 패키지 관리(총관리자 전용은 보안 필터에서 확인). 이름은 자유 문자열이고 권한을 만들지 않는다.
 * 시스템(총관리자) 패키지는 이 서비스로 수정·비활성·삭제할 수 없으며, 일반 패키지는 superAdmin 이 될 수 없다.
 */
@Service
public class PackageService {

    private static final Logger log = LoggerFactory.getLogger(PackageService.class);

    /** null 인 필드는 수정 시 바꾸지 않는다. superAdmin 입력은 존재하지 않는다. */
    public record Command(String name, Boolean active, Map<String, ActionPermission> permissions, DataScope scope) {
    }

    private final PackageRepository repository;
    private final AccountRepository accounts;
    private final PermissionPolicy policy;
    private final AdminMutationLock lock;

    public PackageService(PackageRepository repository, AccountRepository accounts, PermissionPolicy policy,
            AdminMutationLock lock) {
        this.repository = repository;
        this.accounts = accounts;
        this.policy = policy;
        this.lock = lock;
    }

    public List<PermissionPackage> list() {
        return repository.findAll();
    }

    public PermissionPackage get(String packageId) {
        return repository.findById(packageId).orElseThrow(() -> ApiException.notFound("권한 패키지를 찾을 수 없습니다."));
    }

    public long accountCount(String packageId) {
        return accounts.countByPackageId(packageId);
    }

    public PermissionPackage create(Command cmd) {
        return lock.run(() -> {
            String name = validName(cmd.name());
            PermissionPackage pkg = new PermissionPackage(UUID.randomUUID().toString(), name,
                    cmd.active() == null || cmd.active(), false,
                    cmd.permissions() == null ? Map.of() : policy.validate(cmd.permissions()),
                    cmd.scope() == null ? DataScope.none() : cmd.scope());
            requireNameFree(name, null);
            try {
                repository.insert(pkg);
            } catch (DuplicateKeyException e) {
                throw nameTaken();
            }
            log.info("권한 패키지 생성 packageId={}", pkg.packageId());
            return pkg;
        });
    }

    public PermissionPackage update(String packageId, Command cmd) {
        return lock.run(() -> {
            PermissionPackage current = get(packageId);
            if (current.superAdmin()) {
                throw ApiException.conflict("SYSTEM_PACKAGE_PROTECTED", "총관리자 시스템 패키지는 변경할 수 없습니다.");
            }
            PermissionPackage next = current;
            if (cmd.name() != null) {
                next = next.withName(validName(cmd.name()));
            }
            if (cmd.active() != null) {
                next = next.withActive(cmd.active());
            }
            if (cmd.permissions() != null) {
                next = next.withPermissions(policy.validate(cmd.permissions()));
            }
            if (cmd.scope() != null) {
                next = next.withScope(cmd.scope());
            }
            if (cmd.name() != null) {
                requireNameFree(next.name(), packageId);
            }
            try {
                repository.update(next);
            } catch (DuplicateKeyException e) {
                throw nameTaken();
            }
            log.info("권한 패키지 수정 packageId={}", packageId);
            return next;
        });
    }

    public void delete(String packageId) {
        lock.run(() -> {
            PermissionPackage current = get(packageId);
            if (current.superAdmin()) {
                throw ApiException.conflict("SYSTEM_PACKAGE_PROTECTED", "총관리자 시스템 패키지는 삭제할 수 없습니다.");
            }
            if (accounts.countByPackageId(packageId) > 0) {
                throw ApiException.conflict("PACKAGE_IN_USE", "계정이 연결된 패키지는 삭제할 수 없습니다. 계정의 패키지를 먼저 바꾸세요.");
            }
            repository.delete(packageId);
            log.info("권한 패키지 삭제 packageId={}", packageId);
            return null;
        });
    }

    /** local-memory 부트스트랩 전용: 보호된 총관리자 시스템 패키지를 만든다. API 에서는 호출되지 않는다. */
    public PermissionPackage createSystemPackage(String name) {
        return lock.run(() -> {
            PermissionPackage pkg = new PermissionPackage(UUID.randomUUID().toString(), validName(name), true, true,
                    Map.of(), DataScope.all());
            repository.insert(pkg);
            return pkg;
        });
    }

    /** AUTHMSTR 에는 이름 UNIQUE 가 없으므로 관리 잠금 안에서 이름 키(공백 제거·소문자) 중복을 서비스가 막는다. */
    private void requireNameFree(String name, String selfId) {
        repository.findByNameKey(name.strip().toLowerCase(java.util.Locale.ROOT))
                .filter(found -> !found.packageId().equals(selfId)).ifPresent(found -> {
                    throw nameTaken();
                });
    }

    private static String validName(String value) {
        if (value == null || value.isBlank() || value.strip().length() > 50) {
            throw ApiException.badRequest("INVALID_PACKAGE_NAME", "패키지 이름은 1~50자여야 합니다.");
        }
        return value.strip();
    }

    private static ApiException nameTaken() {
        return ApiException.conflict("PACKAGE_NAME_TAKEN", "이미 사용 중인 패키지 이름입니다.");
    }
}
