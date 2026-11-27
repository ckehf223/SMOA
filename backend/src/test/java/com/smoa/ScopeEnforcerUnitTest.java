package com.smoa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.Test;

import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.common.ApiException;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.reference.memory.MemoryReferenceRepository;
import com.smoa.scope.DistrictScoped;
import com.smoa.scope.ScopeEnforcer;
import com.smoa.scope.ScopedRepository;

/** 저장소가 범위 밖 자료를 잘못 돌려줘도 ScopeEnforcer 가 걸러내는지 확인한다(웹 없이 순수 단위). */
class ScopeEnforcerUnitTest {

    record Item(String id, DistrictKey districtKey) implements DistrictScoped {
    }

    /** 범위를 무시하고 전부 돌려주는 불량 저장소. */
    static final class LeakyRepository implements ScopedRepository<Item, String> {
        final List<Item> all = List.of(new Item("1", new DistrictKey("R1", "D1")), new Item("2", new DistrictKey("R2", "D1")),
                new Item("3", new DistrictKey("R1", "D8")));

        @Override
        public List<Item> findAll(DataScope scope) {
            return all;
        }

        @Override
        public Optional<Item> findById(String id, DataScope scope) {
            return all.stream().filter(i -> i.id().equals(id)).findFirst();
        }

        @Override
        public Item insert(Item entity) {
            return entity;
        }

        @Override
        public Optional<Item> update(Item entity, DataScope scope) {
            return Optional.of(entity);
        }

        @Override
        public boolean deleteById(String id, DataScope scope) {
            return true;
        }
    }

    private final ScopeEnforcer enforcer = new ScopeEnforcer(new MemoryReferenceRepository());
    private final LeakyRepository repository = new LeakyRepository();

    private static AccessGrant grant(DataScope scope) {
        Account account = new Account("a", "user", "표시", "p", "hash", true, 1);
        return new AccessGrant(account, "p", "패키지", true, false, Map.of(), Map.of(), scope);
    }

    @Test
    void 저장소가_새어도_목록과_단건은_범위와_구역_활성으로_걸러진다() {
        AccessGrant r1d1 = grant(DataScope.org(List.of(new DistrictKey("R1", "D1"))));
        assertThat(enforcer.list(repository, r1d1)).extracting(Item::id).containsExactly("1");
        assertThat(enforcer.get(repository, "1", r1d1).id()).isEqualTo("1");
        assertThatThrownBy(() -> enforcer.get(repository, "2", r1d1)).isInstanceOf(ApiException.class)
                .hasMessageContaining("찾을 수 없습니다");

        // ALL 이어도 비활성 구역(R1/D8)은 보이지 않는다
        AccessGrant all = grant(DataScope.all());
        assertThat(enforcer.list(repository, all)).extracting(Item::id).containsExactly("1", "2");
        assertThatThrownBy(() -> enforcer.get(repository, "3", all)).isInstanceOf(ApiException.class);
    }

    @Test
    void 배정이_없으면_0건이고_쓰기는_거부된다() {
        AccessGrant none = grant(DataScope.none());
        assertThat(enforcer.list(repository, none)).isEmpty();
        assertThatThrownBy(() -> enforcer.get(repository, "1", none)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> enforcer.create(repository, new Item("9", new DistrictKey("R1", "D1")), none))
                .isInstanceOf(ApiException.class).hasMessageContaining("접근할 수 없는 구역");
        assertThatThrownBy(() -> enforcer.update(repository, "1", none, i -> i)).isInstanceOf(ApiException.class);
    }

    @Test
    void 지역이_다르면_같은_구역코드도_다른_구역이다() {
        DataScope scope = DataScope.org(List.of(new DistrictKey("R1", "D1")));
        assertThat(scope.allows(new DistrictKey("R1", "D1"))).isTrue();
        assertThat(scope.allows(new DistrictKey("R2", "D1"))).isFalse();
        assertThat(scope.allows(null)).isFalse();
        assertThat(DataScope.none().allows(new DistrictKey("R1", "D1"))).isFalse();
        assertThatThrownBy(() -> new DistrictKey("R1", "bad code")).isInstanceOf(IllegalArgumentException.class);
    }
}
