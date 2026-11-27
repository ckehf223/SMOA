package com.smoa.account;

import java.util.function.Supplier;

/** 여러 저장소 호출을 한 트랜잭션으로 묶는 경계. 메모리 구현은 그대로 실행하고, DB 구현은 트랜잭션을 연다. */
public interface UnitOfWork {

    <T> T execute(Supplier<T> work);

    default void run(Runnable work) {
        execute(() -> {
            work.run();
            return null;
        });
    }
}
