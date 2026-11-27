package com.smoa.program;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import com.smoa.account.UnitOfWork;
import com.smoa.common.ApiException;
import com.smoa.module.ModuleRegistry;

/**
 * 프로그램 정보 관리(총관리자 전용은 보안 필터 + 호출 계층에서 확인). programId 는 등록 후 바꿀 수 없다.
 * 등록되지 않은 모듈·형식이 틀린 경로·지원하지 않는 동작은 400.
 */
@Service
public class ProgramService {

    private static final Logger log = LoggerFactory.getLogger(ProgramService.class);

    public static final Pattern PROGRAM_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    public static final Pattern PAGE_PATH = Pattern.compile("/pages/[A-Za-z0-9._-]+\\.html");

    /** programId 는 생성 때만 받는다. null 필드는 수정 시 바꾸지 않는다. */
    public record Command(
            String programId,
            String name,
            String group,
            ProgramCategory category,
            String pagePath,
            String moduleId,
            Set<ProgramAction> actions,
            Boolean superAdminOnly,
            Boolean active,
            Integer sortOrder) {
    }

    private final ProgramRepository repository;
    private final MenuGroupRepository menuGroups;
    private final ModuleRegistry modules;
    private final UnitOfWork work;
    private final ReentrantLock lock = new ReentrantLock();

    public ProgramService(ProgramRepository repository, MenuGroupRepository menuGroups, ModuleRegistry modules, UnitOfWork work) {
        this.repository = repository;
        this.menuGroups = menuGroups;
        this.modules = modules;
        this.work = work;
    }

    public List<Program> list() {
        return repository.findAll();
    }

    public Program get(String programId) {
        return repository.findById(programId).orElseThrow(() -> ApiException.notFound("프로그램을 찾을 수 없습니다."));
    }

    public Program register(Command cmd) {
        lock.lock();
        try {
            if (cmd.programId() == null || !PROGRAM_ID.matcher(cmd.programId()).matches()) {
                throw ApiException.badRequest("INVALID_PROGRAM_ID",
                        "프로그램 ID 는 영문·숫자·_- 1~64자이며 영문/숫자로 시작해야 합니다.");
            }
            if (repository.findById(cmd.programId()).isPresent()) {
                throw ApiException.conflict("PROGRAM_EXISTS", "이미 등록된 프로그램 ID 입니다.");
            }
            Program program = build(cmd.programId(), cmd, null);
            try {
                repository.insert(program);
            } catch (DuplicateKeyException e) {
                throw ApiException.conflict("PROGRAM_EXISTS", "프로그램 ID 또는 페이지 경로가 이미 사용 중입니다.");
            }
            log.info("프로그램 등록 programId={}", program.programId());
            return program;
        } finally {
            lock.unlock();
        }
    }

    public Program update(String programId, Command cmd) {
        lock.lock();
        try {
            if (cmd.programId() != null && !cmd.programId().equals(programId)) {
                throw ApiException.badRequest("PROGRAM_ID_IMMUTABLE", "프로그램 ID 는 바꿀 수 없습니다.");
            }
            Program current = get(programId);
            Program next = build(programId, cmd, current);
            if (current.superAdminOnly() && !next.active()) {
                throw ApiException.conflict("PROTECTED_PROGRAM", "총관리자 전용 관리 프로그램은 비활성화할 수 없습니다.");
            }
            if (current.superAdminOnly() && !next.superAdminOnly()) {
                throw ApiException.conflict("PROTECTED_PROGRAM", "총관리자 전용 표시는 해제할 수 없습니다.");
            }
            try {
                repository.update(next);
            } catch (DuplicateKeyException e) {
                throw ApiException.conflict("PAGE_PATH_TAKEN", "이미 사용 중인 페이지 경로입니다.");
            }
            log.info("프로그램 수정 programId={}", programId);
            return next;
        } finally {
            lock.unlock();
        }
    }

    public record Placement(String programId, String group, int sortOrder, String name) {
    }

    public record UpdatedLayout(MenuLayout layout, List<Program> programs) {
    }

    public MenuLayout menuLayout() {
        lock.lock();
        try {
            return MenuLayout.resolve(repository.findAll(), menuGroups.find(), true);
        } finally {
            lock.unlock();
        }
    }

    public MenuLayout visibleLayout(List<Program> visible) {
        if (visible.isEmpty()) return new MenuLayout(List.of(), List.of());
        return MenuLayout.resolve(visible, menuGroups.find(), false);
    }

    /** 명시적인 폴더 목록과 각 프로그램의 배치를 하나의 트랜잭션으로 저장한다. */
    public UpdatedLayout updateLayout(List<Placement> placements, List<MenuLayout.Group> groups) {
        lock.lock();
        try {
            return work.execute(() -> {
                List<Program> programs = repository.findAll();
                Map<String, Program> byId = new HashMap<>();
                programs.forEach(program -> byId.put(program.programId(), program));
                Map<String, MenuLayout.Group> folders = validateGroups(groups);
                List<Program> changed = new ArrayList<>();
                Set<String> seen = new HashSet<>();
                for (Placement placement : placements) {
                    Program current = byId.get(placement.programId());
                    if (current == null) throw ApiException.notFound("프로그램을 찾을 수 없습니다.");
                    if (!seen.add(current.programId())) {
                        throw ApiException.badRequest("DUPLICATE_PROGRAM", "같은 프로그램을 두 번 배치할 수 없습니다.");
                    }
                    String group = placement.group() == null ? null : MenuLayout.normalizePath(placement.group());
                    if (groups != null && (group == null || (!group.isEmpty() && !folders.containsKey(group)))) {
                        throw ApiException.badRequest("INVALID_PROGRAM_GROUP", "프로그램이 속할 메뉴 폴더를 확인해 주세요.");
                    }
                    Program next = new Program(current.programId(), programName(pick(placement.name(), current.name())),
                            group == null ? current.group() : group, current.category(), current.pagePath(),
                            current.moduleId(), current.actions(), current.superAdminOnly(), current.active(),
                            programOrder(placement.sortOrder()));
                    if (!next.equals(current)) changed.add(next);
                }
                if (groups != null && seen.size() != byId.size()) {
                    throw ApiException.conflict("MENU_PROGRAMS_CHANGED", "프로그램 목록이 바뀌었습니다. 메뉴를 새로 불러와 주세요.");
                }
                changed.forEach(repository::update);
                if (groups != null) menuGroups.save(List.copyOf(folders.values()));
                List<Program> updated = repository.findAll();
                return new UpdatedLayout(MenuLayout.resolve(updated, menuGroups.find(), true), updated);
            });
        } finally {
            lock.unlock();
        }
    }

    private static Map<String, MenuLayout.Group> validateGroups(List<MenuLayout.Group> groups) {
        Map<String, MenuLayout.Group> folders = new HashMap<>();
        if (groups == null) return folders;
        for (MenuLayout.Group group : groups) {
            String path = MenuLayout.normalizePath(group.path());
            if (path.isEmpty() || folders.putIfAbsent(path, new MenuLayout.Group(path, group.sortOrder())) != null) {
                throw ApiException.badRequest("INVALID_MENU_FOLDER", "빈 이름이나 중복된 메뉴 폴더를 저장할 수 없습니다.");
            }
        }
        for (String path : folders.keySet()) {
            String parent = MenuLayout.parent(path);
            if (!parent.isEmpty() && !folders.containsKey(parent)) {
                throw ApiException.badRequest("MISSING_MENU_PARENT", "하위 메뉴에 상위 폴더를 지정해 주세요.");
            }
        }
        return folders;
    }

    private Program build(String programId, Command cmd, Program base) {
        String name = programName(pick(cmd.name(), base == null ? null : base.name()));
        String group = cmd.group() != null ? cmd.group().strip() : base == null ? "" : base.group();
        if (group.length() > 30) {
            throw ApiException.badRequest("INVALID_PROGRAM_GROUP", "그룹은 30자 이하여야 합니다.");
        }
        String pagePath = pick(cmd.pagePath(), base == null ? null : base.pagePath());
        if (pagePath == null || !PAGE_PATH.matcher(pagePath).matches()) {
            throw ApiException.badRequest("INVALID_PAGE_PATH", "페이지 경로는 /pages/<이름>.html 형식이어야 합니다.");
        }
        String moduleId = pick(cmd.moduleId(), base == null ? null : base.moduleId());
        if (moduleId == null || modules.find(moduleId).isEmpty()) {
            throw ApiException.badRequest("UNKNOWN_MODULE",
                    "등록되지 않은 모듈입니다. 새 모듈은 backend 모듈과 frontend 모듈 등록(modules.js)을 먼저 추가해야 합니다.");
        }
        Set<ProgramAction> actions;
        if (cmd.actions() != null) {
            if (cmd.actions().contains(ProgramAction.ACCESS)) {
                throw ApiException.badRequest("INVALID_ACTIONS", "access 는 모든 프로그램에 있으므로 actions 에 적지 않습니다.");
            }
            actions = cmd.actions().isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(cmd.actions()));
        } else {
            actions = base == null ? Set.of() : base.actions();
        }
        ProgramCategory category = cmd.category() != null ? cmd.category()
                : base == null ? ProgramCategory.BUSINESS : base.category();
        boolean superAdminOnly = cmd.superAdminOnly() != null ? cmd.superAdminOnly()
                : base != null && base.superAdminOnly();
        boolean active = cmd.active() != null ? cmd.active() : base == null || base.active();
        int sortOrder = cmd.sortOrder() != null ? cmd.sortOrder() : base == null ? 1000 : base.sortOrder();
        return new Program(programId, name, group, category, pagePath, moduleId, actions, superAdminOnly, active,
                programOrder(sortOrder));
    }

    private static String programName(String name) {
        if (name == null || name.isBlank() || name.strip().length() > 50) {
            throw ApiException.badRequest("INVALID_PROGRAM_NAME", "프로그램 이름은 1~50자여야 합니다.");
        }
        return name.strip();
    }

    private static int programOrder(int sortOrder) {
        if (sortOrder < 0 || sortOrder > 100000) {
            throw ApiException.badRequest("INVALID_SORT_ORDER", "순서는 0~100000 이어야 합니다.");
        }
        return sortOrder;
    }

    private static String pick(String requested, String fallback) {
        return requested != null ? requested.strip() : fallback;
    }
}
