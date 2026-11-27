package com.smoa.account;

import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.permission.AdminMutationLock;
import com.smoa.permission.PackageRepository;
import com.smoa.permission.PermissionPackage;

/**
 * 계정 관리(총관리자 전용). 회원가입은 없다. 모든 변경 메서드는 호출자(actor)가 총관리자인지 다시 확인한다.
 * 계정은 필수 packageId 하나만 가지며 직접 권한·범위·직책은 없다. 미존재/비활성 패키지는 할당할 수 없다.
 * 마지막 활성 총관리자는 비활성화하거나 다른 패키지로 옮길 수 없다. 비밀번호는 응답·로그에 남기지 않는다.
 */
@Service
public class AccountAdminService {

    private static final Logger log = LoggerFactory.getLogger(AccountAdminService.class);

    public record CreateCommand(String username, String displayName, String password, String packageId, Boolean active) {
    }

    /** null 인 필드는 변경하지 않는다. username 은 수정할 수 없다. */
    public record UpdateCommand(String displayName, Boolean active, String packageId) {
    }

    private final AccountRepository repository;
    private final PackageRepository packages;
    private final PasswordEncoder encoder;
    private final AdminMutationLock lock;

    public AccountAdminService(AccountRepository repository, PackageRepository packages, PasswordEncoder encoder,
            AdminMutationLock lock) {
        this.repository = repository;
        this.packages = packages;
        this.encoder = encoder;
        this.lock = lock;
    }

    public List<Account> list(AccessGrant actor) {
        requireSuperAdmin(actor);
        return repository.findAll();
    }

    public Account get(AccessGrant actor, String id) {
        requireSuperAdmin(actor);
        return repository.findById(id).orElseThrow(() -> ApiException.notFound("계정을 찾을 수 없습니다."));
    }

    public Account create(AccessGrant actor, CreateCommand cmd) {
        requireSuperAdmin(actor);
        Account created = createInternal(cmd);
        log.info("계정 생성 actor={} target={} packageId={}", actor.accountId(), created.id(), created.packageId());
        return created;
    }

    /** local-memory 최초 총관리자 초기화용. 계정이 하나도 없을 때만 동작한다. */
    public Account bootstrapSuperAdmin(String username, String password, String systemPackageId) {
        return lock.run(() -> {
            if (!repository.findAll().isEmpty()) {
                throw ApiException.conflict("ALREADY_INITIALIZED", "이미 계정이 있어 최초 총관리자를 만들 수 없습니다.");
            }
            Account created = createUnchecked(new CreateCommand(username, username, password, systemPackageId, true));
            log.info("최초 총관리자 생성 target={}", created.id());
            return created;
        });
    }

    public Account update(AccessGrant actor, String id, UpdateCommand cmd) {
        requireSuperAdmin(actor);
        return lock.run(() -> {
            Account target = repository.findById(id).orElseThrow(() -> ApiException.notFound("계정을 찾을 수 없습니다."));
            Account next = target;
            if (cmd.displayName() != null) {
                next = next.withDisplayName(validDisplayName(cmd.displayName()));
            }
            boolean wasSuper = isActiveSuperAdmin(target);
            if (cmd.packageId() != null && !cmd.packageId().equals(target.packageId())) {
                assignable(cmd.packageId());
                next = next.withPackageId(cmd.packageId());
            }
            if (cmd.active() != null && cmd.active() != target.active()) {
                next = cmd.active() ? next.withActive(true) : next.withActive(false).withBumpedCredentialVersion();
            }
            if (wasSuper && !isActiveSuperAdmin(next) && repository.countActiveSuperAdmins() <= 1) {
                throw ApiException.conflict("LAST_SUPER_ADMIN", "마지막 활성 총관리자는 비활성화하거나 다른 패키지로 옮길 수 없습니다.");
            }
            repository.update(next);
            log.info("계정 수정 actor={} target={}", actor.accountId(), id);
            return next;
        });
    }

    public void resetPassword(AccessGrant actor, String id, String newPassword) {
        requireSuperAdmin(actor);
        lock.run(() -> {
            Account target = repository.findById(id).orElseThrow(() -> ApiException.notFound("계정을 찾을 수 없습니다."));
            PasswordPolicy.validatePassword(target.username(), newPassword);
            repository.update(target.withPassword(encoder.encode(newPassword)));
            log.info("비밀번호 초기화 actor={} target={}", actor.accountId(), id);
            return null;
        });
    }

    private Account createInternal(CreateCommand cmd) {
        return lock.run(() -> createUnchecked(cmd));
    }

    private Account createUnchecked(CreateCommand cmd) {
        PasswordPolicy.validateUsername(cmd.username());
        PasswordPolicy.validatePassword(cmd.username(), cmd.password());
        String displayName = validDisplayName(cmd.displayName());
        if (cmd.packageId() == null || cmd.packageId().isBlank()) {
            throw ApiException.badRequest("PACKAGE_REQUIRED", "권한 패키지를 하나 선택해야 합니다.");
        }
        assignable(cmd.packageId());
        if (repository.findByUsernameKey(Account.usernameKey(cmd.username())).isPresent()) {
            throw duplicate();
        }
        Account account = new Account(UUID.randomUUID().toString(), cmd.username(), displayName, cmd.packageId(),
                encoder.encode(cmd.password()), cmd.active() == null || cmd.active(), 1L);
        try {
            repository.insert(account);
        } catch (DuplicateKeyException e) {
            throw duplicate();
        }
        return account;
    }

    private void assignable(String packageId) {
        PermissionPackage pkg = packages.findById(packageId).orElseThrow(() -> ApiException
                .badRequest("PACKAGE_NOT_FOUND", "존재하지 않는 권한 패키지입니다."));
        if (!pkg.active()) {
            throw ApiException.badRequest("PACKAGE_INACTIVE", "비활성 권한 패키지는 할당할 수 없습니다.");
        }
    }

    private boolean isActiveSuperAdmin(Account account) {
        return account.active() && packages.findById(account.packageId()).filter(p -> p.active() && p.superAdmin()).isPresent();
    }

    private static String validDisplayName(String value) {
        if (value == null || value.isBlank() || value.strip().length() > 50) {
            throw ApiException.badRequest("INVALID_DISPLAY_NAME", "표시명은 1~50자여야 합니다.");
        }
        return value.strip();
    }

    private static ApiException duplicate() {
        return ApiException.conflict("USERNAME_TAKEN", "이미 사용 중인 로그인 ID 입니다.");
    }

    private static void requireSuperAdmin(AccessGrant actor) {
        if (actor == null || !actor.account().active() || !actor.superAdmin()) {
            throw ApiException.forbidden("FORBIDDEN", "총관리자만 계정을 관리할 수 있습니다.");
        }
    }
}
