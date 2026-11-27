package com.smoa;

import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;

import com.smoa.account.Account;
import com.smoa.permission.PermissionPackage;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

/** 패키지·프로그램 변경은 연결된 모든 로그인 계정에 다음 요청부터 반영된다(재로그인 불필요). */
class PackageChangePropagationTest extends ApiTestBase {

    private static Map<String, Object> perm(boolean access, boolean read, boolean write, boolean export) {
        return Map.of("access", access, "read", read, "write", write, "export", export);
    }

    @Test
    void 패키지에_권한을_추가하면_연결된_모든_로그인_계정이_다음_요청부터_받는다() throws Exception {
        enableProgramDuringTest("history");
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("공유", perms("people", ro()), org("R1", "D1"));
        TestClient first = loggedIn(createAccount(pkg));
        TestClient second = loggedIn(createAccount(pkg));
        for (TestClient c : new TestClient[] {first, second}) {
            c.get("/api/programs/history/items").andExpect(status().isForbidden());
            c.post("/api/programs/people/items/none/undelete", Map.of()).andExpect(status().isForbidden()); // write 없음
        }

        admin.patch("/api/admin/packages/" + pkg.packageId(), Map.of("permissions",
                Map.of("people", perm(true, true, true, false), "history", perm(true, true, false, true)))).andExpect(status().isOk());

        for (TestClient c : new TestClient[] {first, second}) {
            c.get("/api/programs/history/items").andExpect(status().isOk());
            c.get("/api/auth/me").andExpect(status().isOk()).andExpect(jsonPath("$.menus.length()").value(2))
                    .andExpect(jsonPath("$.permissions.people.write").value(true));
            c.get("/pages/history.html").andExpect(status().isOk());
        }
    }

    @Test
    void 권한을_회수하면_메뉴_페이지_API가_모두_즉시_막힌다() throws Exception {
        enableProgramDuringTest("history");
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("회수", perms("people", rw(), "history", ro()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        user.get("/api/programs/history/items").andExpect(status().isOk());
        user.get("/pages/history.html").andExpect(status().isOk());

        admin.patch("/api/admin/packages/" + pkg.packageId(), Map.of("permissions", Map.of("people", perm(true, true, true, false))))
                .andExpect(status().isOk());

        user.get("/api/programs/history/items").andExpect(status().isForbidden());
        user.get("/pages/history.html").andExpect(status().isForbidden());
        user.get("/api/auth/me").andExpect(jsonPath("$.menus.length()").value(1));
    }

    @Test
    void 구역을_바꾸면_다음_요청부터_보이는_자료가_바뀐다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("구역", perms("people", rw()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        user.post("/api/programs/people/items", Map.of("name", "가상A", "regionCode", "R1", "districtCode", "D1", "stageId", "찾B"))
                .andExpect(status().isCreated());
        user.post("/api/programs/people/items", Map.of("name", "가상B", "regionCode", "R1", "districtCode", "D2", "stageId", "찾B"))
                .andExpect(status().isForbidden());

        admin.patch("/api/admin/packages/" + pkg.packageId(),
                Map.of("dataScope", Map.of("type", "ORG", "districts", java.util.List.of(Map.of("regionCode", "R1", "districtCode", "D2")))))
                .andExpect(status().isOk());

        user.get("/api/programs/people/items").andExpect(jsonPath("$.length()").value(0));
        user.post("/api/programs/people/items", Map.of("name", "가상B", "regionCode", "R1", "districtCode", "D2", "stageId", "찾B"))
                .andExpect(status().isCreated());
    }

    @Test
    void 패키지를_비활성화하면_연결_계정은_메뉴_없는_상태가_되고_API는_거부된다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("비활성화", perms("people", rw()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        user.get("/api/programs/people/items").andExpect(status().isOk());

        admin.patch("/api/admin/packages/" + pkg.packageId(), Map.of("active", false)).andExpect(status().isOk());

        user.get("/api/programs/people/items").andExpect(status().isForbidden());
        user.get("/pages/people.html").andExpect(status().isForbidden());
        user.get("/api/auth/me").andExpect(status().isOk()).andExpect(jsonPath("$.noMenu").value(true))
                .andExpect(jsonPath("$.packageActive").value(false));

        admin.patch("/api/admin/packages/" + pkg.packageId(), Map.of("active", true)).andExpect(status().isOk());
        user.get("/api/programs/people/items").andExpect(status().isOk());
    }

    @Test
    void 프로그램을_비활성화하면_모든_패키지에서_숨겨지고_직접_요청도_차단된다() throws Exception {
        enableProgramDuringTest("history");
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("프로그램", perms("goals", ro(), "history", ro()), org("R1", "D1"));
        Account account = createAccount(pkg);
        TestClient user = loggedIn(account);
        user.get("/api/programs/goals/module").andExpect(status().isOk());

        admin.patch("/api/admin/programs/goals", Map.of("active", false)).andExpect(status().isOk());
        try {
            user.get("/api/programs/goals/module").andExpect(status().isForbidden());
            user.get("/pages/goals.html").andExpect(status().isForbidden());
            user.get("/api/auth/me").andExpect(jsonPath("$.menus.length()").value(1));
            admin.get("/pages/goals.html").andExpect(status().isForbidden()); // 총관리자도 비활성 프로그램 페이지는 열지 못한다
        } finally {
            admin.patch("/api/admin/programs/goals", Map.of("active", true)).andExpect(status().isOk());
        }
        user.get("/api/programs/goals/module").andExpect(status().isOk());
    }

    @Test
    void 프로그램_동작을_줄이면_패키지에_남은_권한도_유효값으로_정규화된다() throws Exception {
        TestClient admin = loggedInAdmin();
        PermissionPackage pkg = createPackage("정규화", perms("goals", full()), org("R1", "D1"));
        TestClient user = loggedIn(createAccount(pkg));
        user.get("/api/auth/me").andExpect(jsonPath("$.permissions.goals.export").value(true));
        try {
            admin.patch("/api/admin/programs/goals", Map.of("actions", java.util.List.of("read"))).andExpect(status().isOk());
            user.get("/api/auth/me").andExpect(jsonPath("$.permissions.goals.export").value(false))
                    .andExpect(jsonPath("$.permissions.goals.write").value(false));
        } finally {
            admin.patch("/api/admin/programs/goals", Map.of("actions", java.util.List.of("read", "write", "export")))
                    .andExpect(status().isOk());
        }
    }
}
