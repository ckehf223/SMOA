package com.smoa.account.memory;

import java.util.function.Supplier;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import com.smoa.account.UnitOfWork;

/** local-memory: 트랜잭션 없이 그대로 실행한다. */
@Component
@Profile("local-memory")
public class MemoryUnitOfWork implements UnitOfWork {

    @Override
    public <T> T execute(Supplier<T> work) {
        return work.get();
    }
}
